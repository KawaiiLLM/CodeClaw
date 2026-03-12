import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { KernelClient } from "./kernel-client.js";
import type { SkillServiceManager } from "./skill-service-manager.js";

/**
 * Create an SDK-native MCP server exposing CodeClaw's 5 tools.
 *
 * Returns the server config (pass to `mcpServers` in query options)
 * plus a `wasSendMessageCalled()` accessor for the double-send guard.
 */
export function createSdkMcpTools(
  kernelClient: KernelClient,
  skillServiceManager: SkillServiceManager,
): { server: McpSdkServerConfigWithInstance; wasSendMessageCalled: () => boolean; resetSendFlag: () => void } {
  // Double-send guard: tracks whether send_message was invoked in the current turn
  let sentViaToolInTurn = false;

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

  const server = createSdkMcpServer({
    name: "codeclaw",
    version: "0.1.0",
    tools: [sendMessage, skipReply, getQueueStatus, startSkillService, stopSkillService, listSkillServices],
  });

  return {
    server,
    wasSendMessageCalled: () => sentViaToolInTurn,
    resetSendFlag: () => { sentViaToolInTurn = false; },
  };
}
