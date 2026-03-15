// skills/telegram/mcp-server.ts
// Standalone stdio MCP server for Telegram tools.
// Launched by Agent Runtime as a subprocess via McpStdioServerConfig.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Kernel HTTP client (self-contained, no import from agent-runtime) ---

const KERNEL_URL = process.env.KERNEL_URL ?? "http://localhost:19000";
const SKILL_ENDPOINT = process.env.SKILL_ENDPOINT; // e.g. "http://localhost:7001"

async function kernelPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${KERNEL_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Kernel POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sendMessageToKernel(msg: {
  channel: string;
  conversation: string;
  text: string;
  replyTo?: string;
  editMessageId?: string;
}): Promise<{ messageId?: string }> {
  return kernelPost("/api/messages/outbound", {
    channel: msg.channel,
    conversation: msg.conversation,
    content: { type: "text", text: msg.text },
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.editMessageId ? { editMessageId: msg.editMessageId } : {}),
  });
}

async function sendOutbound(msg: {
  channel: string;
  conversation: string;
  skillEndpoint: string;
  payload: Record<string, unknown>;
}): Promise<any> {
  return kernelPost("/api/messages/outbound", {
    channel: msg.channel,
    conversation: msg.conversation,
    content: { type: "text", text: "" },
    skillEndpoint: msg.skillEndpoint,
    payload: msg.payload,
  });
}

// --- MCP Server ---

const server = new McpServer({ name: "telegram", version: "0.1.0" });

server.tool(
  "send_message",
  "Send a message to a Telegram conversation. In group chats, listenMinutes opens a window to receive all group messages (not just @mentions) after sending.",
  {
    channel: z.string().describe("Target channel (e.g. 'telegram')"),
    conversation: z.string().describe("Conversation/chat ID"),
    text: z.string().describe("Message text to send"),
    replyTo: z.string().optional().describe("Message ID to reply to"),
    listenMinutes: z.number().min(0).max(1440).optional().describe("Minutes to listen for all group messages after sending (default 3, 0 to disable)"),
  },
  async ({ channel, conversation, text, replyTo, listenMinutes }) => {
    try {
      await sendMessageToKernel({ channel, conversation, text, replyTo });

      // Activate group watch window (fire-and-forget via Skill HTTP)
      const minutes = listenMinutes ?? 3;
      if (minutes > 0 && SKILL_ENDPOINT) {
        fetch(`${SKILL_ENDPOINT}/watch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation, minutes }),
        }).catch(() => {});
      }

      return { content: [{ type: "text" as const, text: `Message sent to ${channel}/${conversation}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to send: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "react_message",
  "Add or remove an emoji reaction on a message.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Platform message ID (msgId from notification header, NOT seq)"),
    emoji: z.string().describe("Emoji to react with"),
    remove: z.boolean().optional().describe("If true, removes the reaction"),
  },
  async ({ channel, conversation, messageId, emoji, remove }) => {
    try {
      await sendOutbound({ channel, conversation, skillEndpoint: "/react", payload: { conversation, messageId: Number(messageId), emoji, remove } });
      return { content: [{ type: "text" as const, text: `Reaction ${remove ? "removed" : "added"}: ${emoji}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "edit_message",
  "Edit a previously sent bot message.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Platform message ID"),
    text: z.string().describe("New text content"),
  },
  async ({ channel, conversation, messageId, text }) => {
    try {
      await sendMessageToKernel({ channel, conversation, text, editMessageId: messageId });
      return { content: [{ type: "text" as const, text: `Message ${messageId} edited` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "delete_message",
  "Delete a message. Can delete bot's own messages, or others in groups where bot is admin.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Platform message ID"),
  },
  async ({ channel, conversation, messageId }) => {
    try {
      await sendOutbound({ channel, conversation, skillEndpoint: "/delete", payload: { conversation, messageId: Number(messageId) } });
      return { content: [{ type: "text" as const, text: `Message ${messageId} deleted` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "send_sticker",
  "Send a Telegram sticker by fileId. Get fileId from get_sticker_set or chat log JSONL.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    fileId: z.string().describe("Sticker file_id"),
    replyTo: z.string().optional().describe("Message ID to reply to"),
  },
  async ({ channel, conversation, fileId, replyTo }) => {
    try {
      await sendOutbound({ channel, conversation, skillEndpoint: "/sticker", payload: { conversation, fileId, replyTo: replyTo ? Number(replyTo) : undefined } });
      return { content: [{ type: "text" as const, text: "Sticker sent" }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "get_sticker_set",
  "Browse a Telegram sticker set by name. Returns paginated stickers with thumbnails.",
  {
    name: z.string().describe("Sticker set name (e.g. 'HotCherry')"),
    conversation: z.string().optional().describe("Conversation ID (for choose_sticker typing indicator)"),
    offset: z.number().optional().describe("Start index (default 0)"),
    limit: z.number().optional().describe("Number of stickers (default 10, max 20)"),
  },
  async ({ name, conversation, offset, limit }) => {
    try {
      if (!SKILL_ENDPOINT) {
        return { content: [{ type: "text" as const, text: "Telegram skill endpoint not configured" }], isError: true };
      }

      if (conversation) {
        fetch(`${SKILL_ENDPOINT}/action`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation, action: "choose_sticker" }),
        }).catch(() => {});
      }

      const res = await fetch(`${SKILL_ENDPOINT}/sticker_set`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, offset, limit }),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text" as const, text: `Skill error ${res.status}: ${err}` }], isError: true };
      }

      const data = await res.json() as {
        name: string; title: string; total: number; offset: number; count: number;
        stickers: { index: number; fileId: string; emoji: string | null; thumbnail?: string; mimeType?: string; isAnimated: boolean; isVideo: boolean }[];
      };

      const blocks: any[] = [];
      blocks.push({ type: "text" as const, text: `${data.title} (${data.name}) — showing ${data.offset + 1}-${data.offset + data.count} of ${data.total}` });
      for (const s of data.stickers) {
        if (s.thumbnail && s.mimeType) {
          blocks.push({ type: "image" as const, data: s.thumbnail, mimeType: s.mimeType });
        }
        blocks.push({ type: "text" as const, text: `#${s.index} file_id=${s.fileId} emoji=${s.emoji ?? "none"}${s.isAnimated ? " [animated]" : ""}${s.isVideo ? " [video]" : ""}` });
      }
      if (data.offset + data.count < data.total) {
        blocks.push({ type: "text" as const, text: `(${data.total - data.offset - data.count} more — use offset=${data.offset + data.count})` });
      }
      return { content: blocks };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "send_poll",
  "Create a poll in a conversation.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    question: z.string().describe("Poll question"),
    options: z.array(z.string()).describe("Poll options (2-10 items)"),
    isAnonymous: z.boolean().optional().describe("Anonymous voting (default true)"),
    allowsMultiple: z.boolean().optional().describe("Allow multiple answers (default false)"),
  },
  async ({ channel, conversation, question, options, isAnonymous, allowsMultiple }) => {
    try {
      const res = await sendOutbound({ channel, conversation, skillEndpoint: "/poll", payload: { conversation, question, options, isAnonymous, allowsMultiple } });
      const pollId = res?.pollId;
      return { content: [{ type: "text" as const, text: `Poll created${pollId ? ` (id: ${pollId})` : ""}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "get_message",
  "Fetch a specific message from chat history. Returns full content including images.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    date: z.string().describe("Date string (e.g. '2026-03-13')"),
    seq: z.number().optional().describe("Message seq number within that day's file"),
    platformMessageId: z.number().optional().describe("Platform-specific message ID (alternative to seq)"),
  },
  async ({ channel, conversation, date, seq, platformMessageId }) => {
    try {
      const data = await sendOutbound({
        channel, conversation,
        skillEndpoint: "/get_message",
        payload: { conversation, date, seq, messageId: platformMessageId },
      }) as { error?: string; message: Record<string, any>; attachments: { mimeType: string; data: string }[] };

      if (data.error) return { content: [{ type: "text" as const, text: `Not found: ${data.error}` }], isError: true };

      const blocks: any[] = [];
      const msg = data.message;
      const sender = msg.sender?.name ?? "Unknown";
      blocks.push({ type: "text" as const, text: `[${date}/seq:${msg.seq}] ${sender} (${msg.type}):` });
      if (msg.text) blocks.push({ type: "text" as const, text: String(msg.text) });
      if (msg.caption) blocks.push({ type: "text" as const, text: String(msg.caption) });
      for (const att of data.attachments) {
        if (att.mimeType.startsWith("image/")) {
          blocks.push({ type: "image" as const, data: att.data, mimeType: att.mimeType });
        } else {
          blocks.push({ type: "text" as const, text: `[attachment: ${att.mimeType}]` });
        }
      }
      if (msg.emoji) blocks.push({ type: "text" as const, text: `emoji: ${msg.emoji}` });
      return { content: blocks };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// --- Progress state (shared by Layer 1 typing and Layer 2 show_progress) ---

let progressMsgId: number | null = null;
let progressConv: string | null = null;

server.tool(
  "show_progress",
  `Toggle a progress status message in the conversation. Use ONLY for long-running tasks (multi-step file analysis, complex searches, etc.) — not for quick replies.

When active=true: creates or updates a visible status message and suppresses the automatic typing indicator.
When active=false: deletes the status message and resumes automatic typing.

Typical flow:
1. show_progress(active: true, status: "Analyzing chat history...")
2. ...do work (Read, Grep, Bash, etc.)...
3. show_progress(active: true, status: "Processing results...")
4. ...more work...
5. When ready to reply, call show_progress(active: false) in PARALLEL with send_message.`,
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    active: z.boolean().describe("true to show/update progress, false to dismiss"),
    status: z.string().optional().describe("Status text (required when active=true)"),
  },
  async ({ channel, conversation, active, status }) => {
    try {
      if (active) {
        if (!status) {
          return { content: [{ type: "text" as const, text: "status is required when active=true" }], isError: true };
        }
        if (progressMsgId && progressConv === conversation) {
          // Edit existing progress message
          await kernelPost("/api/messages/outbound", {
            channel,
            conversation,
            content: { type: "text", text: status },
            editMessageId: String(progressMsgId),
          });
        } else {
          // Clean up old progress message if switching conversation
          if (progressMsgId && progressConv) {
            sendOutbound({ channel, conversation: progressConv, skillEndpoint: "/delete", payload: { conversation: progressConv, messageId: progressMsgId } }).catch(() => {});
          }
          // Send new progress message (progress: true skips JSONL)
          const res = await kernelPost("/api/messages/outbound", {
            channel,
            conversation,
            content: { type: "text", text: status },
            progress: true,
          });
          progressMsgId = res?.messageId ? Number(res.messageId) : null;
          progressConv = conversation;
        }
        return { content: [{ type: "text" as const, text: "Progress shown" }] };
      } else {
        // Dismiss progress message
        if (progressMsgId && progressConv) {
          await sendOutbound({ channel, conversation: progressConv, skillEndpoint: "/delete", payload: { conversation: progressConv, messageId: progressMsgId } }).catch(() => {});
          progressMsgId = null;
          progressConv = null;
        }
        return { content: [{ type: "text" as const, text: "Progress dismissed" }] };
      }
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// --- Typing auto-poll (Layer 1) ---

const TYPING_POLL_MS = 5000;
const AGENT_ID = process.env.AGENT_ID ?? "andy";

function sendTyping(conversation: string): void {
  if (!SKILL_ENDPOINT) return;
  fetch(`${SKILL_ENDPOINT}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation, action: "typing" }),
  }).catch(() => {});
}

setInterval(async () => {
  try {
    const res = await fetch(`${KERNEL_URL}/api/agent/health`);
    if (!res.ok) return;
    const data = await res.json() as Record<string, { status: string; conversation?: string }>;
    const agent = data[AGENT_ID];
    if (!agent) return;

    if (agent.status === "busy" && agent.conversation) {
      // Layer 2 active → skip typing
      if (progressMsgId) return;

      // Layer 1: send typing
      const [channel, convId] = agent.conversation.split("/", 2);
      if (channel === "telegram" && convId) {
        sendTyping(convId);
      }
    } else if (agent.status === "idle" || agent.status === "alive") {
      // Safety net: clean up lingering progress message
      if (progressMsgId && progressConv) {
        sendOutbound({
          channel: "telegram",
          conversation: progressConv,
          skillEndpoint: "/delete",
          payload: { conversation: progressConv, messageId: progressMsgId },
        }).catch(() => {});
        progressMsgId = null;
        progressConv = null;
      }
    }
  } catch {
    // Kernel unreachable, silently skip
  }
}, TYPING_POLL_MS);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
