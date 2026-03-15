// packages/agent-runtime/src/core-mcp-server.ts
// Standalone stdio MCP server for core agent-system tools (inter-agent communication, etc.).
// Launched by Agent Runtime as a subprocess alongside skill-specific MCP servers.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KERNEL_URL = process.env.KERNEL_URL ?? "http://localhost:19000";
const AGENT_ID = process.env.AGENT_ID;

async function kernelPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${KERNEL_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Kernel POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- MCP Server ---

const server = new McpServer({ name: "core", version: "0.1.0" });

server.tool(
  "list_agents",
  "List all agents in the system and their current status.",
  {},
  async () => {
    try {
      const res = await fetch(`${KERNEL_URL}/api/agent/health`);
      if (!res.ok) throw new Error(`Kernel returned ${res.status}`);
      const data = await res.json() as Record<string, { status: string; conversation?: string; timestamp?: number }>;
      const agents = Object.entries(data).map(([id, info]) => {
        const self = id === AGENT_ID ? " (you)" : "";
        return `${id}${self}: ${info.status}`;
      });
      if (agents.length === 0) {
        return { content: [{ type: "text" as const, text: "No agents registered" }] };
      }
      return { content: [{ type: "text" as const, text: agents.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "send_to_agent",
  "Send a message to another agent's inbound queue. Use this to communicate with other agents — ask for help, delegate tasks, or share context. Include any relevant context (e.g. which chat to respond in) in the message text itself.",
  {
    targetAgent: z.string().describe("Target agent ID (e.g. 'anon', 'sakiko')"),
    message: z.string().describe("Message text to send"),
  },
  async ({ targetAgent, message }) => {
    try {
      if (targetAgent === AGENT_ID) {
        return { content: [{ type: "text" as const, text: "Cannot send to self" }], isError: true };
      }
      await kernelPost("/api/messages/inbound", {
        id: `agent_${AGENT_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        channel: "agent",
        agentId: targetAgent,
        sender: {
          id: `agent:${AGENT_ID}`,
          name: `Agent:${AGENT_ID}`,
          channel: "agent",
        },
        conversation: { id: `agent:${AGENT_ID}`, type: "dm" },
        content: { type: "text", text: message },
        timestamp: Date.now(),
      });
      return { content: [{ type: "text" as const, text: `Message delivered to agent ${targetAgent}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed: ${msg}` }], isError: true };
    }
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
