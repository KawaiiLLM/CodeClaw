import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KernelClient } from "./kernel-client.js";
import { SkillServiceManager } from "./skill-service-manager.js";
import { logger } from "./logger.js";

export function createMcpServer(
  kernelClient: KernelClient,
  skillServiceManager: SkillServiceManager,
): McpServer {
  const server = new McpServer({
    name: "codeclaw",
    version: "0.1.0",
  });

  // --- Core communication tools ---

  server.tool(
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
        return { content: [{ type: "text" as const, text: `Message sent to ${channel}/${conversation}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to send: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_queue_status",
    "Check pending message queue status",
    {},
    async () => {
      try {
        const status = await kernelClient.getQueueStatus();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(status, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed: ${msg}` }], isError: true };
      }
    },
  );

  // --- Skill management tools ---

  server.tool(
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

  server.tool(
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

  server.tool(
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

  return server;
}

/**
 * Start the MCP server on stdio transport.
 * Called as a separate process by the agent SDK.
 */
export async function startMcpServer(): Promise<void> {
  const kernelClient = new KernelClient();
  const skillServiceManager = new SkillServiceManager(kernelClient);
  const server = createMcpServer(kernelClient, skillServiceManager);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started on stdio");
}
