import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KernelClient } from "./kernel-client.js";
import { logger } from "./logger.js";

export function createMcpServer(
  kernelClient: KernelClient,
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

  return server;
}

/**
 * Start the MCP server on stdio transport.
 * Called as a separate process by the agent SDK.
 */
export async function startMcpServer(): Promise<void> {
  const kernelClient = new KernelClient();
  const server = createMcpServer(kernelClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started on stdio");
}
