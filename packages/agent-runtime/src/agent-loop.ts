import type { InboundMessage } from "@codeclaw/types";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageInjector } from "./message-injector.js";
import { KernelClient } from "./kernel-client.js";
import { logger } from "./logger.js";

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

/**
 * Wrap a text string into an SDKUserMessage for the Streaming Input API.
 */
function toSDKUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: text,
    },
    parent_tool_use_id: null,
    session_id: "",
  };
}

/**
 * Create the AsyncGenerator that feeds messages into the Claude Agent SDK's
 * Streaming Input mode.
 */
export async function* createMessageStream(
  injector: MessageInjector,
): AsyncGenerator<SDKUserMessage> {
  logger.info("Message stream started, waiting for first message...");

  // Wait for the first inbound message
  const firstMsg = await injector.waitForMessage();
  logger.info({ channel: firstMsg.channel, sender: firstMsg.sender.name }, "First message received");
  yield toSDKUserMessage(formatMessageForAgent(firstMsg));

  // Continuous: yield new messages as they arrive
  while (true) {
    const msg = await injector.waitForMessage();
    logger.info({ channel: msg.channel, sender: msg.sender.name }, "New message received");

    const pendingCount = injector.pendingCount();
    if (pendingCount > 0) {
      yield toSDKUserMessage(
        `[System] New message + ${pendingCount} more pending:\n${formatMessageForAgent(msg)}`,
      );
    } else {
      yield toSDKUserMessage(formatMessageForAgent(msg));
    }
  }
}

/**
 * Start the agent loop using the Claude Agent SDK.
 */
export async function startAgentLoop(opts: {
  injector: MessageInjector;
  kernelClient: KernelClient;
  agentId: string;
  workspacePath: string;
  mcpServerPath: string;
  resumeSessionId?: string;
}): Promise<void> {
  const { injector, kernelClient, agentId, workspacePath, mcpServerPath, resumeSessionId } = opts;

  const kernelUrl = process.env.KERNEL_URL ?? "http://host.docker.internal:19000";

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
    // Dynamic import — SDK may not be installed in dev environment
    const sdk = await import("@anthropic-ai/claude-agent-sdk").catch(() => null);

    if (!sdk?.query) {
      logger.warn("Claude Agent SDK not available, running in stub mode");
      await runStubLoop(injector, kernelClient, agentId);
      return;
    }

    const messageStream = createMessageStream(injector);

    logger.info({ agentId, workspacePath }, "Starting Agent SDK query with Streaming Input");

    for await (const event of sdk.query({
      prompt: messageStream,
      options: {
        cwd: workspacePath,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        systemPrompt: { type: "preset", preset: "claude_code" },
        allowedTools: [
          "Bash", "Read", "Write", "Edit", "Glob", "Grep",
          "WebSearch", "WebFetch", "Agent",
          "mcp__codeclaw__*",
        ],
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        mcpServers: {
          codeclaw: {
            command: "node",
            args: [mcpServerPath],
            env: { KERNEL_URL: kernelUrl },
          },
        },
      },
    })) {
      // Handle SDK events with runtime-safe property access
      const ev = event as Record<string, unknown>;

      if (ev.type === "system" && typeof ev.session_id === "string") {
        logger.info({ sessionId: ev.session_id }, "SDK session initialized");
        await kernelClient.reportHealth(agentId, "alive", { sessionId: ev.session_id });
      }

      if (ev.type === "assistant" && typeof ev.uuid === "string") {
        await kernelClient.reportHealth(agentId, "busy", {
          lastAssistantMessageId: ev.uuid,
        });
      }

      if (ev.type === "result") {
        logger.info("Agent produced a result");
      }
    }
  } finally {
    clearInterval(healthInterval);
  }
}

/**
 * Stub loop for development without the SDK.
 * Simply logs messages and echoes them back.
 */
async function runStubLoop(
  injector: MessageInjector,
  kernelClient: KernelClient,
  agentId: string,
): Promise<void> {
  logger.info("Running stub agent loop (no SDK)");

  while (true) {
    const msg = await injector.waitForMessage();
    const formatted = formatMessageForAgent(msg);
    logger.info({ formatted }, "Stub agent received message");

    // Echo response
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
