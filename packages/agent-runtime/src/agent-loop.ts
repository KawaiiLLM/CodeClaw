import type { InboundMessage } from "@codeclaw/types";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { MessageInjector } from "./message-injector.js";
import { KernelClient } from "./kernel-client.js";
import type { SkillServiceManager } from "./skill-service-manager.js";
import { ProgressTracker } from "./progress-tracker.js";
import { logger } from "./logger.js";

// --- SDK dynamic import ---

let sdkAvailable = false;
let sdkQuery: typeof import("@anthropic-ai/claude-agent-sdk").query;
let sdkListSessions: typeof import("@anthropic-ai/claude-agent-sdk").listSessions;

try {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  sdkQuery = sdk.query;
  sdkListSessions = sdk.listSessions;
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

// --- Session management types ---

/** How to start the next SDK loop iteration. */
type SessionAction =
  | { type: "continue" }     // continue most recent session (default on startup)
  | { type: "new" }          // start a fresh session
  | { type: "resume"; sessionId: string }  // resume a specific session
  | { type: "exit" };        // shut down

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

/** MCP tools that send a visible reply — stop typing when detected in event stream */
const SEND_TOOLS = new Set(["mcp__telegram__send_message", "mcp__telegram__send_sticker", "mcp__telegram__send_poll"]);

async function runSdkLoop(
  injector: MessageInjector,
  kernelClient: KernelClient,
  agentId: string,
  workspacePath: string,
  sessionConfig: SessionAction,
  skillServiceManager: SkillServiceManager,
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>,
): Promise<SessionAction> {
  const model = process.env.CLAUDE_MODEL ?? "aws-claude-opus-4-6";
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const httpProxy = resolveProxy();

  logger.info({ model, baseURL: baseURL ?? "(default)", workspacePath, sessionConfig }, "Running in SDK mode");

  // Session switch: set by handleRuntimeCommand, checked after interrupt causes result
  let pendingAction: SessionAction | null = null;

  // Track last message for fallback reply routing
  let lastMessage: InboundMessage | null = null;
  let sessionId = "";
  let cumulativeCost = 0;

  // Progress tracker: renders live tool chain in Telegram, mirrors CC's terminal UI
  const progressTracker = new ProgressTracker(kernelClient);

  // Stop typing when progress message appears (typing becomes redundant)
  progressTracker.onProgressStarted(() => stopTyping());

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

  // Create the message stream (empty — first message pushed after command filtering)
  const stream = new MessageStream();

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
      settingSources: ["user", "project"],
      model,
      cwd: process.env.HOME ?? workspacePath,
      env,
      mcpServers,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
      includePartialMessages: true,
      stderr: (data: string) => {
        logger.warn({ stderr: data.trimEnd() }, "SDK: subprocess stderr");
      },
      ...(sessionConfig.type === "continue" ? { continue: true } : {}),
      ...(sessionConfig.type === "resume" ? { resume: sessionConfig.sessionId } : {}),
      // "new" and "exit" don't need special options (fresh session)
    },
  });

  /** Handle a slash command at the Runtime level. Returns true if handled (don't push to stream). */
  async function handleRuntimeCommand(msg: InboundMessage): Promise<boolean> {
    const meta = (msg as any).metadata as { command?: string; args?: string; raw?: string } | undefined;
    if (!meta?.command) return false;

    const cmd = meta.command;
    const args = meta.args ?? "";

    if (cmd === "/model") {
      if (!args) {
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: `Current model: ${model}` },
          replyTo: msg.id,
        }).catch(() => {});
        return true;
      }
      try {
        await q.setModel(args);
        logger.info({ newModel: args }, "SDK: model changed via /model command");
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: `Model switched to: ${args}` },
          replyTo: msg.id,
        }).catch(() => {});
      } catch (err) {
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}` },
          replyTo: msg.id,
        }).catch(() => {});
      }
      return true;
    }

    if (cmd === "/interrupt") {
      try {
        await q.interrupt();
        logger.info("SDK: interrupted via /interrupt command");
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: "Interrupted." },
          replyTo: msg.id,
        }).catch(() => {});
      } catch (err) {
        logger.error({ err }, "SDK: /interrupt failed");
      }
      return true;
    }

    if (cmd === "/cost") {
      // cumulativeCost is tracked from result messages
      await kernelClient.sendMessage({
        channel: msg.channel, conversation: msg.conversation.id,
        content: { type: "text", text: `Session cost: $${cumulativeCost.toFixed(4)}` },
        replyTo: msg.id,
      }).catch(() => {});
      return true;
    }

    if (cmd === "/session") {
      if (!args) {
        // List sessions
        try {
          const sessions = await sdkListSessions({ dir: process.env.HOME ?? workspacePath, limit: 10 });
          if (sessions.length === 0) {
            await kernelClient.sendMessage({
              channel: msg.channel, conversation: msg.conversation.id,
              content: { type: "text", text: "No sessions found." },
              replyTo: msg.id,
            }).catch(() => {});
          } else {
            const currentMark = (id: string) => id === sessionId ? " ← current" : "";
            const lines = sessions.map((s, i) => {
              const date = new Date(s.lastModified).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
              const title = s.customTitle ?? s.summary ?? s.firstPrompt ?? "(untitled)";
              const shortId = s.sessionId.slice(0, 8);
              return `${i + 1}. \`${shortId}\` ${title} (${date})${currentMark(s.sessionId)}`;
            });
            await kernelClient.sendMessage({
              channel: msg.channel, conversation: msg.conversation.id,
              content: { type: "text", text: lines.join("\n") },
              replyTo: msg.id,
            }).catch(() => {});
          }
        } catch (err) {
          await kernelClient.sendMessage({
            channel: msg.channel, conversation: msg.conversation.id,
            content: { type: "text", text: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}` },
            replyTo: msg.id,
          }).catch(() => {});
        }
        return true;
      }

      if (args === "new") {
        // Start new session — interrupt current, restart with fresh session
        pendingAction = { type: "new" };
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: "Starting new session..." },
          replyTo: msg.id,
        }).catch(() => {});
        try { await q.interrupt(); } catch { /* best effort */ }
        return true;
      }

      // /session <id> — resume a specific session
      // Match full UUID or prefix (at least 4 chars)
      const targetId = args.trim();
      if (targetId.length >= 4) {
        try {
          const sessions = await sdkListSessions({ dir: process.env.HOME ?? workspacePath, limit: 100 });
          const match = sessions.find((s) => s.sessionId.startsWith(targetId));
          if (!match) {
            await kernelClient.sendMessage({
              channel: msg.channel, conversation: msg.conversation.id,
              content: { type: "text", text: `No session found matching "${targetId}".` },
              replyTo: msg.id,
            }).catch(() => {});
            return true;
          }
          if (match.sessionId === sessionId) {
            await kernelClient.sendMessage({
              channel: msg.channel, conversation: msg.conversation.id,
              content: { type: "text", text: "Already in this session." },
              replyTo: msg.id,
            }).catch(() => {});
            return true;
          }
          pendingAction = { type: "resume", sessionId: match.sessionId };
          const title = match.customTitle ?? match.summary ?? match.firstPrompt ?? "(untitled)";
          await kernelClient.sendMessage({
            channel: msg.channel, conversation: msg.conversation.id,
            content: { type: "text", text: `Resuming session: ${title}...` },
            replyTo: msg.id,
          }).catch(() => {});
          try { await q.interrupt(); } catch { /* best effort */ }
        } catch (err) {
          await kernelClient.sendMessage({
            channel: msg.channel, conversation: msg.conversation.id,
            content: { type: "text", text: `Failed to switch session: ${err instanceof Error ? err.message : String(err)}` },
            replyTo: msg.id,
          }).catch(() => {});
        }
        return true;
      }

      // Prefix too short
      await kernelClient.sendMessage({
        channel: msg.channel, conversation: msg.conversation.id,
        content: { type: "text", text: "Session ID prefix must be at least 4 characters." },
        replyTo: msg.id,
      }).catch(() => {});
      return true;
    }

    // Not a runtime command — let it pass through to SDK
    return false;
  }

  // Wait for the first non-command message before starting the SDK query
  let firstMsg: InboundMessage;
  while (true) {
    firstMsg = await injector.waitForMessage();
    lastMessage = firstMsg;
    if (await handleRuntimeCommand(firstMsg)) continue;
    break;
  }
  const firstFormatted = await formatMessageForAgent(firstMsg);
  logger.info({ formatted: firstFormatted }, "SDK: received first message");

  await kernelClient.reportHealth(agentId, "busy").catch(() => {});
  startTyping();
  progressTracker.setTarget(firstMsg.channel, firstMsg.conversation.id, firstMsg.id);

  // Seed stream with first message
  stream.push(firstFormatted, sessionId);

  // Background coroutine: continuously read from injector and push to stream
  let pumpStopped = false;
  const pumpMessages = async () => {
    while (!pumpStopped) {
      try {
        const msg = await injector.waitForMessage();
        if (pumpStopped) {
          // Session switched while we were waiting — re-queue so next loop picks it up
          injector.push(msg);
          break;
        }
        lastMessage = msg;

        // Check for runtime commands
        if (await handleRuntimeCommand(msg)) continue;

        // Check for SDK commands — push raw command text, not notification header
        const meta = (msg as any).metadata as { command?: string; raw?: string } | undefined;
        if (meta?.command) {
          // SDK command: push just the command text (e.g. "/compact")
          logger.info({ command: meta.raw }, "SDK: forwarding command to SDK");
          stream.push(meta.raw ?? meta.command, sessionId);
          continue;
        }

        // Normal message
        const formatted = await formatMessageForAgent(msg);
        logger.info({ formatted: typeof formatted === "string" ? formatted : "[multimodal]" }, "SDK: injecting message");
        stream.push(formatted, sessionId);
        await kernelClient.reportHealth(agentId, "busy").catch(() => {});
        startTyping();
        progressTracker.setTarget(msg.channel, msg.conversation.id, msg.id);
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
        } else if ((msg as any).subtype === "task_started") {
          progressTracker.onSubAgentStarted((msg as any).task_id, (msg as any).description ?? "Sub-task");
        } else if ((msg as any).subtype === "task_progress") {
          const tp = msg as any;
          progressTracker.onSubAgentProgress(tp.task_id, tp.last_tool_name, tp.usage?.tool_uses);
        } else if ((msg as any).subtype === "task_notification") {
          progressTracker.onSubAgentCompleted((msg as any).task_id);
        } else {
          logger.debug({ subtype: (msg as any).subtype }, "SDK: system message");
        }
        continue;
      }

      // Stream events: detect tool calls in real-time (before AssistantMessage)
      if (msg.type === "stream_event") {
        const event = (msg as any).event;
        const parentId = (msg as any).parent_tool_use_id;

        if (event?.type === "message_start" && !parentId) {
          progressTracker.onNewResponse();
        }

        if (event?.type === "content_block_start" && !parentId) {
          const block = event.content_block;
          if (block?.type === "tool_use" || block?.type === "mcp_tool_use") {
            progressTracker.onToolStarted(block.id, block.name);

            // Stop typing + clear progress when agent calls a send-type tool
            if (SEND_TOOLS.has(block.name)) {
              stopTyping();
              progressTracker.cleanup().catch(() => {});
            }
          }
        }
        continue;
      }

      // Tool progress heartbeats (elapsed time during execution)
      if ((msg as any).type === "tool_progress") {
        const tp = msg as any;
        progressTracker.onToolProgress(tp.tool_use_id, tp.elapsed_time_seconds);
        continue;
      }

      // AssistantMessage: resolve tool labels with full parsed input
      if (msg.type === "assistant") {
        if (!(msg as any).parent_tool_use_id) {
          const content = (msg as any).message?.content ?? [];
          for (const block of content) {
            if (block.type === "tool_use" || block.type === "mcp_tool_use") {
              progressTracker.onToolInputResolved(block.id, block.input);
            }
          }
        }
        continue;
      }

      if (msg.type === "result") {
        stopTyping();
        await progressTracker.cleanup();

        if (msg.subtype === "success") {
          cumulativeCost += msg.total_cost_usd ?? 0;
          sessionId = msg.session_id;
          logger.info(
            {
              sessionId: msg.session_id,
              cost: msg.total_cost_usd,
              turns: msg.num_turns,
              durationMs: msg.duration_ms,
              inputTokens: msg.usage.input_tokens,
              outputTokens: msg.usage.output_tokens,
            },
            "SDK: turn completed",
          );
        } else {
          // Error result
          const errors = "errors" in msg ? msg.errors : [];
          const errorStr = errors.join("; ");

          // doExport 401 is a non-fatal SDK telemetry error (proxy key != real Anthropic key)
          // SDK auto-recovers on next message, so just log and skip user notification
          const isExportError = errorStr.includes("doExport") || errorStr.includes("AxiosError: Request failed with status code 401");
          if (isExportError) {
            logger.warn({ subtype: msg.subtype }, "SDK: suppressed doExport 401 (proxy key, non-fatal)");
          } else {
            logger.error({ subtype: msg.subtype, errors }, "SDK: turn error");

            if (lastMessage) {
              const errorText = errors.length > 0
                ? `[Error] ${errorStr}`
                : `[Error] Agent stopped: ${msg.subtype}`;
              await kernelClient.sendMessage({
                channel: lastMessage.channel,
                conversation: lastMessage.conversation.id,
                content: { type: "text", text: errorText },
                replyTo: lastMessage.id,
              }).catch(() => {});
            }
          }
        }

        // Check if a session switch was requested (set by /session command before interrupt)
        if (pendingAction) {
          logger.info({ pendingAction }, "SDK: session switch requested, breaking loop");
          break;
        }

        await kernelClient.reportHealth(agentId, "idle", { sessionId }).catch(() => {});
        continue;
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
    await progressTracker.cleanup().catch(() => {});
    pumpStopped = true;
    stream.end();
    try { q.close(); } catch { /* best effort */ }
  }

  // Return the next action
  return pendingAction ?? { type: "continue" };
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
  skillServiceManager: SkillServiceManager;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}): Promise<void> {
  const { injector, kernelClient, agentId, workspacePath, skillServiceManager, mcpServers } = opts;

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
      // Restartable SDK loop: each iteration is one session
      let nextAction: SessionAction = { type: "continue" };
      while (nextAction.type !== "exit") {
        logger.info({ action: nextAction }, "SDK: starting session");
        nextAction = await runSdkLoop(injector, kernelClient, agentId, workspacePath, nextAction, skillServiceManager, mcpServers);
        if (nextAction.type !== "exit") {
          logger.info({ nextAction }, "SDK: restarting with new session config");
        }
      }
    } else if (mode === "chat") {
      await runChatLoop(injector, kernelClient, agentId);
    } else {
      await runStubLoop(injector, kernelClient, agentId);
    }
  } finally {
    clearInterval(healthInterval);
  }
}
