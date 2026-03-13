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
} {
  // Double-send guard: tracks whether send_message was invoked in the current turn
  let sentViaToolInTurn = false;

  // Callback to resolve current conversation from agent-loop's lastMessage
  let getConversation: (() => ConversationInfo | null) | null = null;

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

  const server = createSdkMcpServer({
    name: "codeclaw",
    version: "0.1.0",
    tools: [sendMessage, skipReply, updateProgress, getQueueStatus, startSkillService, stopSkillService, listSkillServices],
  });

  return {
    server,
    wasSendMessageCalled: () => sentViaToolInTurn,
    resetSendFlag: () => { sentViaToolInTurn = false; },
    getCurrentConversation: (fn: () => ConversationInfo | null) => { getConversation = fn; },
  };
}
