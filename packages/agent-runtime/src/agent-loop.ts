import type { InboundMessage } from "@codeclaw/types";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { MessageInjector } from "./message-injector.js";
import { KernelClient } from "./kernel-client.js";
import type { SkillServiceManager } from "./skill-service-manager.js";
import { logger } from "./logger.js";

// --- SDK dynamic import ---

let sdkAvailable = false;
let sdkQuery: typeof import("@anthropic-ai/claude-agent-sdk").query;
let createSdkMcpToolsFn: typeof import("./sdk-mcp-tools.js").createSdkMcpTools;

try {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  sdkQuery = sdk.query;
  const toolsMod = await import("./sdk-mcp-tools.js");
  createSdkMcpToolsFn = toolsMod.createSdkMcpTools;
  sdkAvailable = true;
  logger.info("Claude Agent SDK loaded successfully");
} catch (err) {
  logger.info({ err }, "Claude Agent SDK not available, falling back to chat/stub");
}

// --- Helpers ---

/**
 * Resolve the HTTP proxy URL from common environment variables.
 */
function resolveProxy(): string | undefined {
  return process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY
    ?? process.env.http_proxy ?? process.env.https_proxy;
}


/**
 * Convert InboundMessage content to SDK-compatible format.
 * Skill has already formatted notification text and embedded metadata.
 * This function only handles the generic MessageContent → SDK conversion.
 */
async function formatMessageForAgent(msg: InboundMessage): Promise<MessageParam["content"]> {
  if (msg.content.type === "text") {
    return msg.content.text;
  }

  if (msg.content.type === "image") {
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (msg.content.caption) {
      blocks.push({ type: "text", text: msg.content.caption });
    }
    if (msg.content.data && msg.content.mimeType) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: msg.content.mimeType as "image/jpeg", data: msg.content.data },
      });
    }
    return blocks.length > 0 ? blocks : `[${msg.channel}] image without data`;
  }

  return `[${msg.channel}] unsupported content type: ${msg.content.type}`;
}

// --- Agent modes ---

type AgentMode = "sdk" | "chat" | "stub";

function detectMode(): AgentMode {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  let mode: AgentMode;
  if (sdkAvailable && hasKey) {
    mode = "sdk";
  } else if (hasKey) {
    mode = "chat";
  } else {
    mode = "stub";
  }
  logger.info({ mode, sdkAvailable, hasKey }, "Agent mode detected");
  return mode;
}

// --- SDK mode: full Claude Code agent via Agent SDK ---

const SDK_SYSTEM_APPEND = `You are CodeClaw, a personal AI agent running inside a Docker container.
Your home directory is ~ (/home/codeclaw). This is your persistent workspace.

You receive messages from various channels (Telegram, web, etc.) via a message queue.
Each message includes metadata embedded in the content text by the channel Skill.
Extract channel and conversation ID from the message header [channel/chatId].

DIRECTORY STRUCTURE:
- ~/.claude/skills/     — Installed Skills (each has SKILL.md with channel-specific details)
- ~/.claude/data/       — Skill persistent data (chat logs, files)
- ~/.claude/cache/      — Temporary files (safe to clean)
- ~/.claude/memory/     — Your long-term memory
- ~/.claude/config/     — Configuration files
- ~/Projects/           — Create project directories here as needed

RULES:
- Messages may include reply-to references — use get_message to fetch context if needed
- Keep responses concise and helpful`;

/**
 * Bridges MessageInjector → AsyncIterable<SDKUserMessage> for the SDK query() stream input.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiter: ((msg: SDKUserMessage | null) => void) | null = null;
  private done = false;

  push(content: MessageParam["content"], sessionId: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  end(): void {
    this.done = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null); // Unblock the iterator with a sentinel
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    while (true) {
      const queued = this.queue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.done) return;
      const msg = await new Promise<SDKUserMessage | null>((resolve) => {
        this.waiter = resolve;
      });
      if (msg === null) return; // Sentinel from end()
      yield msg;
    }
  }
}

/** Send a chat action (e.g. "typing") directly to the Skill, bypassing Kernel. */
function sendChatAction(
  skillServiceManager: SkillServiceManager,
  channel: string,
  conversationId: string,
  action: string,
): void {
  const endpoint = skillServiceManager.getEndpoint(channel);
  if (!endpoint) return;
  // Global fetch is correct here: /action goes to localhost (same container), no proxy needed
  fetch(`${endpoint}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation: conversationId, action }),
  }).catch(() => {}); // Fire-and-forget, failures silently ignored
}

const TYPING_INTERVAL_MS = 4000;

async function runSdkLoop(
  injector: MessageInjector,
  kernelClient: KernelClient,
  agentId: string,
  workspacePath: string,
  resumeSessionId: string | undefined,
  skillServiceManager: SkillServiceManager,
): Promise<void> {
  const model = process.env.CLAUDE_MODEL ?? "aws-claude-opus-4-6";
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const httpProxy = resolveProxy();

  logger.info({ model, baseURL: baseURL ?? "(default)", workspacePath }, "Running in SDK mode");

  // Create MCP tools with double-send guard
  const { server: mcpServer, wasSendMessageCalled, resetSendFlag, getCurrentConversation: setConversationCallback, onMessageSent } =
    createSdkMcpToolsFn(kernelClient, skillServiceManager);

  // Track last message for fallback reply routing
  let lastMessage: InboundMessage | null = null;
  let sessionId = "";

  // Stop typing as soon as agent sends a reply (don't wait for SDK result event)
  onMessageSent(() => stopTyping());

  // Wire up auto-routing: update_progress reads channel/conversation from lastMessage
  setConversationCallback(() => {
    if (!lastMessage) return null;
    return {
      channel: lastMessage.channel,
      conversationId: lastMessage.conversation.id,
      lastMessageId: lastMessage.id,
    };
  });

  // Typing indicator interval
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  function startTyping(): void {
    stopTyping();
    if (!lastMessage) return;
    const { channel, conversation } = lastMessage;
    // Send immediately, then repeat every 4s
    sendChatAction(skillServiceManager, channel, conversation.id, "typing");
    typingTimer = setInterval(() => {
      sendChatAction(skillServiceManager, channel, conversation.id, "typing");
    }, TYPING_INTERVAL_MS);
  }

  function stopTyping(): void {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  }

  // Wait for the first message before starting the SDK query
  const firstMsg = await injector.waitForMessage();
  lastMessage = firstMsg;
  const firstFormatted = await formatMessageForAgent(firstMsg);
  logger.info({ formatted: firstFormatted }, "SDK: received first message");

  await kernelClient.reportHealth(agentId, "busy").catch(() => {});
  startTyping();

  // Create the message stream and seed with first message
  const stream = new MessageStream();
  stream.push(firstFormatted, sessionId);
  resetSendFlag();

  // Background coroutine: continuously read from injector and push to stream
  const pumpMessages = async () => {
    while (true) {
      try {
        const msg = await injector.waitForMessage();
        lastMessage = msg;
        const formatted = await formatMessageForAgent(msg);
        logger.info({ formatted: typeof formatted === "string" ? formatted : "[multimodal]" }, "SDK: injecting message");
        resetSendFlag(); // Reset flag for the new turn
        stream.push(formatted, sessionId);
        await kernelClient.reportHealth(agentId, "busy").catch(() => {});
        startTyping();
      } catch (err) {
        logger.error({ err }, "SDK: message pump error");
        break;
      }
    }
  };
  const pumpPromise = pumpMessages();
  pumpPromise.catch((err) => {
    logger.error({ err }, "SDK: message pump crashed");
    stream.end();
  });

  // Build environment for the SDK subprocess
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
    ...(httpProxy ? {
      HTTP_PROXY: httpProxy,
      HTTPS_PROXY: httpProxy,
      http_proxy: httpProxy,
      https_proxy: httpProxy,
    } : {}),
  };

  const q = sdkQuery({
    prompt: stream,
    options: {
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: SDK_SYSTEM_APPEND,
      },
      settingSources: ["project"],
      model,
      cwd: process.env.HOME ?? workspacePath,
      env,
      mcpServers: {
        codeclaw: mcpServer,
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
      stderr: (data: string) => {
        logger.warn({ stderr: data.trimEnd() }, "SDK: subprocess stderr");
      },
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  try {
    for await (const msg of q) {
      if (msg.type === "system") {
        if (msg.subtype === "init") {
          sessionId = msg.session_id;
          logger.info(
            { sessionId, model: msg.model, tools: msg.tools.length, mcpServers: msg.mcp_servers },
            "SDK: session initialized",
          );
          await kernelClient.reportHealth(agentId, "busy", { sessionId }).catch(() => {});
        } else {
          logger.debug({ subtype: (msg as any).subtype }, "SDK: system message");
        }
        continue;
      }

      if (msg.type === "result") {
        stopTyping();
        if (msg.subtype === "success") {
          sessionId = msg.session_id;
          logger.info(
            {
              sessionId: msg.session_id,
              cost: msg.total_cost_usd,
              turns: msg.num_turns,
              durationMs: msg.duration_ms,
              inputTokens: msg.usage.input_tokens,
              outputTokens: msg.usage.output_tokens,
              resultLength: msg.result?.length ?? 0,
              sentViaTool: wasSendMessageCalled(),
            },
            "SDK: turn completed",
          );

          // Only auto-send result if send_message was NOT called by the agent
          if (!wasSendMessageCalled() && msg.result && lastMessage) {
            await kernelClient.sendMessage({
              channel: lastMessage.channel,
              conversation: lastMessage.conversation.id,
              content: { type: "text", text: msg.result },
              replyTo: lastMessage.id,
            }).catch((err) => {
              logger.error({ err }, "SDK: failed to send fallback result");
            });
          }
        } else {
          // Error result
          const errors = "errors" in msg ? msg.errors : [];
          logger.error({ subtype: msg.subtype, errors }, "SDK: turn error");

          if (lastMessage) {
            const errorText = errors.length > 0
              ? `[Error] ${errors.join("; ")}`
              : `[Error] Agent stopped: ${msg.subtype}`;
            await kernelClient.sendMessage({
              channel: lastMessage.channel,
              conversation: lastMessage.conversation.id,
              content: { type: "text", text: errorText },
              replyTo: lastMessage.id,
            }).catch(() => {});
          }
        }

        resetSendFlag(); // Reset for next turn
        await kernelClient.reportHealth(agentId, "idle", { sessionId }).catch(() => {});
        continue;
      }

      // Other message types (assistant, stream_event, etc.) — log at debug level
      if (msg.type === "assistant") {
        logger.debug({ type: msg.type }, "SDK: assistant message");
      }
    }

    logger.info("SDK: query stream ended");
  } catch (err) {
    logger.error({ err }, "SDK: query failed");

    if (lastMessage) {
      const message = err instanceof Error ? err.message : String(err);
      await kernelClient.sendMessage({
        channel: lastMessage.channel,
        conversation: lastMessage.conversation.id,
        content: { type: "text", text: `[Error] SDK agent crashed: ${message}` },
        replyTo: lastMessage.id,
      }).catch(() => {});
    }
  } finally {
    stopTyping();
    stream.end();
    try { q.close(); } catch { /* best effort */ }
  }
}

// --- Chat mode: real Claude API via Anthropic SDK ---

const SYSTEM_PROMPT = `You are CodeClaw, a personal AI assistant running inside a Docker container.
Your home directory ~ is your persistent workspace.
You receive messages from various channels (Telegram, web, etc.) via a message queue.
Messages are formatted as notifications: [channel/conversationId] Sender: content.
Reply naturally and helpfully. Keep responses concise.
You can use markdown formatting in your replies.`;

const MAX_HISTORY = 50; // Keep last N messages for context

/**
 * Trim history to MAX_HISTORY and ensure it starts with a "user" message
 * (required by the Anthropic Messages API).
 */
function trimHistory(history: Anthropic.MessageParam[]): void {
  while (history.length > MAX_HISTORY) {
    history.shift();
  }
  while (history.length > 0 && history[0].role !== "user") {
    history.shift();
  }
}

async function runChatLoop(
  injector: MessageInjector,
  kernelClient: KernelClient,
  agentId: string,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const model = process.env.CLAUDE_MODEL ?? "aws-claude-opus-4-6";
  const httpProxy = resolveProxy();

  // Build a proxied fetch if HTTP proxy is set (for containers behind a firewall)
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
    const formatted = await formatMessageForAgent(msg);
    logger.info({ formatted: typeof formatted === "string" ? formatted : "[multimodal]" }, "Chat: received message");

    // Add to conversation history and trim
    history.push({ role: "user", content: formatted });
    trimHistory(history);

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
          const isRetryable =
            err instanceof Anthropic.APIConnectionError || err?.code === "ECONNRESET";
          if (isRetryable && attempt < 3) {
            logger.warn({ attempt, error: err.message }, "Chat: retrying after transient error");
            await new Promise((r) => setTimeout(r, 1000 * attempt));
            continue;
          }
          throw err;
        }
      }

      if (!response) {
        throw new Error("All retry attempts exhausted without a response");
      }

      // Extract text from response
      const textBlocks = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text);
      const replyText = textBlocks.join("\n") || "(No response)";

      // Add assistant response to history
      history.push({ role: "assistant", content: replyText });

      logger.info(
        { model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
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

      // Add synthetic assistant message to maintain alternating roles (I3)
      history.push({ role: "assistant", content: `[Error: ${message}]` });

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
    const formatted = await formatMessageForAgent(msg);
    logger.info({ formatted: typeof formatted === "string" ? formatted : "[multimodal]" }, "Stub agent received message");

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
 * Start the agent loop. Automatically selects the best available mode:
 * - sdk:  Agent SDK + API key → full Claude Code agent with tools
 * - chat: API key only → pure chat via Messages API
 * - stub: no API key → echo for development
 */
export async function startAgentLoop(opts: {
  injector: MessageInjector;
  kernelClient: KernelClient;
  agentId: string;
  workspacePath: string;
  resumeSessionId?: string;
  skillServiceManager: SkillServiceManager;
}): Promise<void> {
  const { injector, kernelClient, agentId, workspacePath, resumeSessionId, skillServiceManager } = opts;

  // Report initial health
  await kernelClient.reportHealth(agentId, "alive").catch(() => {});

  // Heartbeat interval — reports "alive" so kernel knows agent is reachable
  const healthInterval = setInterval(async () => {
    try {
      await kernelClient.reportHealth(agentId, "alive");
    } catch {
      // Kernel may be temporarily unavailable
    }
  }, 10_000);

  try {
    const mode = detectMode();

    if (mode === "sdk") {
      await runSdkLoop(injector, kernelClient, agentId, workspacePath, resumeSessionId, skillServiceManager);
    } else if (mode === "chat") {
      await runChatLoop(injector, kernelClient, agentId);
    } else {
      await runStubLoop(injector, kernelClient, agentId);
    }
  } finally {
    clearInterval(healthInterval);
  }
}
