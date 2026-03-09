import type { InboundMessage } from "@codeclaw/types";
import Anthropic from "@anthropic-ai/sdk";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { MessageInjector } from "./message-injector.js";
import { KernelClient } from "./kernel-client.js";
import { logger } from "./logger.js";

// --- Helpers ---

/**
 * Format an inbound message into the text the agent sees.
 */
function formatMessageForAgent(msg: InboundMessage): string {
  const source = `[${msg.channel}/${msg.conversation.id}]`;
  const sender = msg.sender.name;

  if (msg.content.type === "text") {
    return `${source} ${sender}: ${msg.content.text}`;
  }
  if (msg.content.type === "image") {
    return `${source} ${sender}: [Image] ${msg.content.caption ?? msg.content.url}`;
  }
  if (msg.content.type === "audio") {
    return `${source} ${sender}: [Audio ${msg.content.duration ?? "?"}s] ${msg.content.url}`;
  }
  if (msg.content.type === "file") {
    return `${source} ${sender}: [File] ${msg.content.filename} ${msg.content.url}`;
  }
  return `${source} ${sender}: [Unknown content type]`;
}

// --- Agent modes ---

type AgentMode = "chat" | "stub";

function detectMode(): AgentMode {
  if (process.env.ANTHROPIC_API_KEY) return "chat";
  return "stub";
}

// --- Chat mode: real Claude API via Anthropic SDK ---

const SYSTEM_PROMPT = `You are CodeClaw, a personal AI assistant running inside a Docker container.
You receive messages from various channels (Telegram, web, etc.) via a message queue.
Each message is prefixed with [channel/conversationId] sender: content.
Reply naturally and helpfully. Keep responses concise.
You can use markdown formatting in your replies.`;

const MAX_HISTORY = 50; // Keep last N messages for context

async function runChatLoop(
  injector: MessageInjector,
  kernelClient: KernelClient,
  agentId: string,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const model = process.env.CLAUDE_MODEL ?? "aws-claude-opus-4-6";
  const httpProxy = process.env.HTTP_PROXY ?? process.env.https_proxy;

  // Build a proxied fetch if HTTP_PROXY is set (for containers behind a firewall)
  let customFetch: typeof globalThis.fetch | undefined;
  if (httpProxy) {
    const dispatcher = new ProxyAgent(httpProxy);
    customFetch = ((input: any, init?: any) =>
      undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch;
    logger.info({ proxy: httpProxy }, "Using HTTP proxy for API calls");
  }

  const client = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(customFetch ? { fetch: customFetch } : {}),
  });

  logger.info({ model, baseURL: baseURL ?? "(default)" }, "Running in chat mode");

  const history: Anthropic.MessageParam[] = [];

  while (true) {
    const msg = await injector.waitForMessage();
    const formatted = formatMessageForAgent(msg);
    logger.info({ formatted }, "Chat: received message");

    // Add to conversation history
    history.push({ role: "user", content: formatted });

    // Trim history if too long
    while (history.length > MAX_HISTORY) {
      history.shift();
    }

    await kernelClient.reportHealth(agentId, "busy").catch(() => {});

    try {
      // Retry on transient network errors (up to 3 attempts)
      let response: Anthropic.Message | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await client.messages.create({
            model,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: history,
          });
          break;
        } catch (err: any) {
          const isRetryable = err?.type === "APIConnectionError" || err?.code === "ECONNRESET";
          if (isRetryable && attempt < 3) {
            logger.warn({ attempt, error: err.message }, "Chat: retrying after transient error");
            await new Promise((r) => setTimeout(r, 1000 * attempt));
            continue;
          }
          throw err;
        }
      }

      // Extract text from response
      const textBlocks = response!.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text);
      const replyText = textBlocks.join("\n") || "(No response)";

      // Add assistant response to history
      history.push({ role: "assistant", content: replyText });

      logger.info(
        { model: response!.model, inputTokens: response!.usage.input_tokens, outputTokens: response!.usage.output_tokens },
        "Chat: Claude responded",
      );

      // Send reply back through kernel
      await kernelClient.sendMessage({
        channel: msg.channel,
        conversation: msg.conversation.id,
        content: { type: "text", text: replyText },
        replyTo: msg.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Chat: API call failed");

      // Send error message back so user knows something went wrong
      await kernelClient.sendMessage({
        channel: msg.channel,
        conversation: msg.conversation.id,
        content: { type: "text", text: `[Error] API call failed: ${message}` },
        replyTo: msg.id,
      }).catch(() => {});
    }

    await kernelClient.reportHealth(agentId, "idle").catch(() => {});
  }
}

// --- Stub mode: echo replies for development ---

async function runStubLoop(
  injector: MessageInjector,
  kernelClient: KernelClient,
  agentId: string,
): Promise<void> {
  logger.info("Running stub agent loop (no API key)");

  while (true) {
    const msg = await injector.waitForMessage();
    const formatted = formatMessageForAgent(msg);
    logger.info({ formatted }, "Stub agent received message");

    if (msg.content.type === "text") {
      try {
        await kernelClient.sendMessage({
          channel: msg.channel,
          conversation: msg.conversation.id,
          content: {
            type: "text",
            text: `[CodeClaw Agent] I received your message: "${msg.content.text}". (Running in stub mode — SDK not available)`,
          },
          replyTo: msg.id,
        });
      } catch (err) {
        logger.error({ err }, "Stub: failed to send reply");
      }
    }

    await kernelClient.reportHealth(agentId, "idle");
  }
}

// --- Entry point ---

/**
 * Start the agent loop. Automatically selects chat mode (with API key)
 * or stub mode (without).
 */
export async function startAgentLoop(opts: {
  injector: MessageInjector;
  kernelClient: KernelClient;
  agentId: string;
  workspacePath: string;
  mcpServerPath: string;
  resumeSessionId?: string;
}): Promise<void> {
  const { injector, kernelClient, agentId } = opts;

  // Report initial health
  await kernelClient.reportHealth(agentId, "alive").catch(() => {});

  // Health report interval
  const healthInterval = setInterval(async () => {
    try {
      await kernelClient.reportHealth(agentId, "busy");
    } catch {
      // Kernel may be temporarily unavailable
    }
  }, 10_000);

  try {
    const mode = detectMode();

    if (mode === "chat") {
      await runChatLoop(injector, kernelClient, agentId);
    } else {
      await runStubLoop(injector, kernelClient, agentId);
    }
  } finally {
    clearInterval(healthInterval);
  }
}
