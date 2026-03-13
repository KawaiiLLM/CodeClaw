import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { KernelClient } from "./kernel-client.js";
import type { SkillServiceManager } from "./skill-service-manager.js";

export interface ConversationInfo {
  channel: string;
  conversationId: string;
  lastMessageId?: string;
}

/**
 * Create an SDK-native MCP server exposing CodeClaw's tools.
 *
 * Returns the server config (pass to `mcpServers` in query options)
 * plus a `wasSendMessageCalled()` accessor for the double-send guard,
 * and a `getCurrentConversation` setter for auto-routing in update_progress.
 */
export function createSdkMcpTools(
  kernelClient: KernelClient,
  skillServiceManager: SkillServiceManager,
): {
  server: McpSdkServerConfigWithInstance;
  wasSendMessageCalled: () => boolean;
  resetSendFlag: () => void;
  getCurrentConversation: (fn: () => ConversationInfo | null) => void;
  onMessageSent: (fn: () => void) => void;
} {
  // Double-send guard: tracks whether send_message was invoked in the current turn
  let sentViaToolInTurn = false;

  // Callback to resolve current conversation from agent-loop's lastMessage
  let getConversation: (() => ConversationInfo | null) | null = null;

  // Callback to notify agent-loop that a message was sent (e.g. to stop typing)
  let messageSentCallback: (() => void) | null = null;

  const sendMessage = tool(
    "send_message",
    "Send a message to a specific channel/conversation",
    {
      channel: z.string().describe("Target channel (e.g. 'telegram', 'web')"),
      conversation: z.string().describe("Conversation/chat ID"),
      text: z.string().describe("Message text to send"),
      replyTo: z.string().optional().describe("Message ID to reply to"),
    },
    async ({ channel, conversation, text, replyTo }) => {
      try {
        await kernelClient.sendMessage({
          channel,
          conversation,
          content: { type: "text", text },
          replyTo,
        });
        sentViaToolInTurn = true;
        messageSentCallback?.();
        return { content: [{ type: "text" as const, text: `Message sent to ${channel}/${conversation}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to send: ${msg}` }], isError: true };
      }
    },
  );

  const getQueueStatus = tool(
    "get_queue_status",
    "Check pending message queue status",
    {},
    async () => {
      try {
        const status = await kernelClient.getQueueStatus();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  const startSkillService = tool(
    "start_skill_service",
    "Start a skill service process",
    {
      skillId: z.string().describe("Unique identifier for the skill"),
      command: z.string().describe("Command to run (e.g. 'node')"),
      args: z.array(z.string()).optional().describe("Command arguments"),
    },
    async ({ skillId, command, args }) => {
      try {
        await skillServiceManager.start({ skillId, command, args });
        return { content: [{ type: "text" as const, text: `Skill service '${skillId}' started` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  const stopSkillService = tool(
    "stop_skill_service",
    "Stop a running skill service",
    {
      skillId: z.string().describe("Skill ID to stop"),
    },
    async ({ skillId }) => {
      try {
        await skillServiceManager.stop(skillId);
        return { content: [{ type: "text" as const, text: `Skill service '${skillId}' stopped` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  const listSkillServices = tool(
    "list_skill_services",
    "List all running skill services",
    {},
    async () => {
      const services = skillServiceManager.list();
      return {
        content: [{
          type: "text" as const,
          text: services.length > 0
            ? JSON.stringify(services, null, 2)
            : "No skill services running",
        }],
      };
    },
  );

  const skipReply = tool(
    "skip_reply",
    "Acknowledge a message without sending a reply. Use when you see a group message during an active window that doesn't need a response.",
    {},
    async () => {
      sentViaToolInTurn = true;
      return { content: [{ type: "text" as const, text: "Reply skipped" }] };
    },
  );

  const updateProgress = tool(
    "update_progress",
    "Send or edit a progress message in the current conversation. Use for long-running tasks to keep the user informed. First call sends a new message and returns messageId; subsequent calls with messageId edit the existing message. Does NOT count as a final reply.",
    {
      text: z.string().describe("Progress text to show (e.g. '⏳ Analyzing your code...')"),
      messageId: z.string().optional().describe("Message ID from a previous update_progress call. If provided, edits the existing message instead of sending a new one."),
    },
    // Note: does NOT set sentViaToolInTurn — progress is not a final reply
    async ({ text, messageId }) => {
      try {
        const conv = getConversation?.();
        if (!conv) {
          return { content: [{ type: "text" as const, text: "No active conversation to send progress to" }], isError: true };
        }
        const { channel, conversationId, lastMessageId } = conv;

        if (messageId) {
          // Edit existing progress message
          await kernelClient.sendMessage({
            channel,
            conversation: conversationId,
            content: { type: "text", text },
            editMessageId: messageId,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ messageId }) }] };
        } else {
          // Send new progress message
          const res = await kernelClient.sendMessage({
            channel,
            conversation: conversationId,
            content: { type: "text", text },
            replyTo: lastMessageId,
            progress: true,
          });
          const newId = res.messageId ? String(res.messageId) : undefined;
          return { content: [{ type: "text" as const, text: JSON.stringify({ messageId: newId }) }] };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  const reactMessage = tool(
    "react_message",
    "Add or remove an emoji reaction on a message. Use to acknowledge messages, express emotions, or give quick feedback.",
    {
      channel: z.string().describe("Target channel (e.g. 'telegram')"),
      conversation: z.string().describe("Conversation/chat ID"),
      messageId: z.string().describe("Platform message ID (msgId from notification header, NOT seq)"),
      emoji: z.string().describe("Emoji to react with. Must be supported by the target platform."),
      remove: z.boolean().optional().describe("If true, removes the reaction"),
    },
    async ({ channel, conversation, messageId, emoji, remove }) => {
      try {
        await kernelClient.sendOutbound({
          channel, conversation,
          skillEndpoint: "/react",
          payload: { conversation, messageId: Number(messageId), emoji, remove },
        });
        return { content: [{ type: "text" as const, text: `Reaction ${remove ? "removed" : "added"}: ${emoji}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  const editMessage = tool(
    "edit_message",
    "Edit a previously sent bot message.",
    {
      channel: z.string().describe("Target channel"),
      conversation: z.string().describe("Conversation/chat ID"),
      messageId: z.string().describe("Platform message ID (msgId from notification header)"),
      text: z.string().describe("New text content"),
    },
    async ({ channel, conversation, messageId, text }) => {
      try {
        await kernelClient.sendMessage({ channel, conversation, content: { type: "text", text }, editMessageId: messageId });
        return { content: [{ type: "text" as const, text: `Message ${messageId} edited` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  const deleteMessage = tool(
    "delete_message",
    "Delete a message. Can delete bot's own messages, or others in groups where bot is admin.",
    {
      channel: z.string().describe("Target channel"),
      conversation: z.string().describe("Conversation/chat ID"),
      messageId: z.string().describe("Platform message ID (msgId from notification header)"),
    },
    async ({ channel, conversation, messageId }) => {
      try {
        await kernelClient.sendOutbound({
          channel, conversation,
          skillEndpoint: "/delete",
          payload: { conversation, messageId: Number(messageId) },
        });
        return { content: [{ type: "text" as const, text: `Message ${messageId} deleted` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  const sendSticker = tool(
    "send_sticker",
    "Send a sticker to a conversation. Use get_sticker_set first to browse available stickers.",
    {
      channel: z.string().describe("Target channel"),
      conversation: z.string().describe("Conversation/chat ID"),
      fileId: z.string().describe("Sticker file_id from get_sticker_set"),
      replyTo: z.string().optional().describe("Message ID to reply to"),
    },
    async ({ channel, conversation, fileId, replyTo }) => {
      try {
        sentViaToolInTurn = true;
        messageSentCallback?.();
        await kernelClient.sendOutbound({
          channel, conversation,
          skillEndpoint: "/sticker",
          payload: { conversation, fileId, replyTo: replyTo ? Number(replyTo) : undefined },
        });
        return { content: [{ type: "text" as const, text: "Sticker sent" }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  const getStickerSet = tool(
    "get_sticker_set",
    "Browse a sticker set with visual thumbnails. Returns paginated stickers (default 10). Use to see what stickers look like before sending one.",
    {
      channel: z.string().describe("Target channel"),
      name: z.string().describe("Sticker set name (e.g. 'HotCherry')"),
      offset: z.number().optional().describe("Start index (default 0)"),
      limit: z.number().optional().describe("Number of stickers to return (default 10)"),
    },
    async ({ channel, name, offset, limit }) => {
      try {
        // Hook: auto-trigger choose_sticker action
        const conv = getConversation?.();
        if (conv) {
          const ep = skillServiceManager.getEndpoint(conv.channel);
          if (ep) {
            fetch(`${ep}/action`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ conversation: conv.conversationId, action: "choose_sticker" }),
            }).catch(() => {});
          }
        }

        const data = await kernelClient.sendOutbound({
          channel, conversation: "",
          skillEndpoint: "/sticker_set",
          payload: { name, offset, limit },
        }) as {
          name: string; title: string; total: number; offset: number; count: number;
          stickers: { index: number; fileId: string; emoji: string | null; thumbnail?: string; mimeType?: string; isAnimated: boolean; isVideo: boolean }[];
        };

        const blocks: any[] = [];
        blocks.push({ type: "text" as const, text: `${data.title} (${data.name}) — showing ${data.offset + 1}-${data.offset + data.count} of ${data.total}` });

        for (const s of data.stickers) {
          if (s.thumbnail && s.mimeType) {
            blocks.push({ type: "image" as const, data: s.thumbnail, mimeType: s.mimeType });
          }
          const label = `#${s.index} file_id=${s.fileId} emoji=${s.emoji ?? "none"}${s.isAnimated ? " [animated]" : ""}${s.isVideo ? " [video]" : ""}`;
          blocks.push({ type: "text" as const, text: label });
        }

        if (data.offset + data.count < data.total) {
          blocks.push({ type: "text" as const, text: `(${data.total - data.offset - data.count} more — use offset=${data.offset + data.count} to see next page)` });
        }

        return { content: blocks };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  const sendPoll = tool(
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
        sentViaToolInTurn = true;
        messageSentCallback?.();
        const res = await kernelClient.sendOutbound({
          channel, conversation,
          skillEndpoint: "/poll",
          payload: { conversation, question, options, isAnonymous, allowsMultiple },
        });
        const pollId = (res as any)?.pollId;
        return { content: [{ type: "text" as const, text: `Poll created${pollId ? ` (id: ${pollId})` : ""}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  const getMessage = tool(
    "get_message",
    "Fetch a specific message from chat history. Returns full content including images. Use when you need to see a referenced message not in your current session (e.g. from a reply-to reference).",
    {
      channel: z.string().describe("Target channel"),
      conversation: z.string().describe("Conversation/chat ID"),
      date: z.string().describe("Date string (e.g. '2026-03-13')"),
      seq: z.number().optional().describe("Message seq number within that day's file"),
      platformMessageId: z.number().optional().describe("Platform-specific message ID (alternative to seq)"),
    },
    async ({ channel, conversation, date, seq, platformMessageId }) => {
      try {
        const data = await kernelClient.sendOutbound({
          channel, conversation,
          skillEndpoint: "/get_message",
          payload: { conversation, date, seq, messageId: platformMessageId },
        }) as {
          success?: boolean;
          error?: string;
          message: Record<string, unknown>;
          attachments: { mimeType: string; data: string }[];
        };

        if (data.error) return { content: [{ type: "text" as const, text: `Not found: ${data.error}` }], isError: true };

        const blocks: any[] = [];
        const msg = data.message;
        const sender = (msg.sender as any)?.name ?? "Unknown";
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

  const server = createSdkMcpServer({
    name: "codeclaw",
    version: "0.1.0",
    tools: [
      sendMessage, skipReply, updateProgress, getQueueStatus,
      reactMessage, editMessage, deleteMessage,
      sendSticker, getStickerSet, sendPoll, getMessage,
      startSkillService, stopSkillService, listSkillServices,
    ],
  });

  return {
    server,
    wasSendMessageCalled: () => sentViaToolInTurn,
    resetSendFlag: () => { sentViaToolInTurn = false; },
    getCurrentConversation: (fn: () => ConversationInfo | null) => { getConversation = fn; },
    onMessageSent: (fn: () => void) => { messageSentCallback = fn; },
  };
}
