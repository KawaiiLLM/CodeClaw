import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  InboundMessage,
  OutboundMessage,
  SkillServiceRegistration,
  AgentHealthReport,
} from "@codeclaw/types";
import { MessageQueue } from "./message-queue.js";
import { IOBridge } from "./io-bridge.js";
import { AgentSupervisor } from "./agent-supervisor.js";
import { ContainerManager } from "./container-manager.js";
import { logger } from "./logger.js";

interface ServerDeps {
  messageQueue: MessageQueue;
  ioBridge: IOBridge;
  supervisor: AgentSupervisor;
  containerManager: ContainerManager;
  startedAt: number;
}

type RouteHandler = (body: unknown) => Promise<unknown>;

export function createHttpServer(deps: ServerDeps) {
  const { messageQueue, ioBridge, supervisor, containerManager, startedAt } = deps;

  // --- Route handlers ---

  const routes: Record<string, Record<string, RouteHandler>> = {
    POST: {
      "/api/messages/inbound": async (body) => {
        const msg = body as InboundMessage;
        if (!msg.id || !msg.channel || !msg.content) {
          throw new HttpError(400, "Missing required fields: id, channel, content");
        }
        const enqueued = ioBridge.handleInbound(msg);
        return { success: true, enqueued };
      },

      "/api/messages/outbound": async (body) => {
        const msg = body as OutboundMessage;
        if (!msg.channel || !msg.conversation || !msg.content) {
          throw new HttpError(400, "Missing required fields: channel, conversation, content");
        }
        await ioBridge.routeOutbound(msg);
        return { success: true };
      },

      "/api/services/register": async (body) => {
        const reg = body as SkillServiceRegistration;
        if (!reg.skillId || !reg.type || !reg.endpoint) {
          throw new HttpError(400, "Missing required fields: skillId, type, endpoint");
        }
        ioBridge.registerService(reg);
        return { success: true };
      },

      "/api/services/unregister": async (body) => {
        const { skillId } = body as { skillId: string };
        if (!skillId) {
          throw new HttpError(400, "Missing required field: skillId");
        }
        ioBridge.unregisterService(skillId);
        return { success: true };
      },

      "/api/agent/health": async (body) => {
        const report = body as AgentHealthReport;
        if (!report.agentId || !report.status) {
          throw new HttpError(400, "Missing required fields: agentId, status");
        }
        report.timestamp = Date.now();
        supervisor.reportHealth(report);
        return { success: true };
      },
    },

    GET: {
      "/api/messages/next": async () => {
        const msg = messageQueue.dequeue();
        return msg ?? { empty: true };
      },

      "/api/messages/queue": async () => {
        return {
          pending: messageQueue.pendingCount(),
          channels: messageQueue.channels(),
          byChannel: messageQueue.pendingByChannel(),
        };
      },

      "/api/status": async () => {
        return {
          uptime: Date.now() - startedAt,
          services: ioBridge.getAllServices(),
          queue: {
            pending: messageQueue.pendingCount(),
            channels: messageQueue.channels(),
            byChannel: messageQueue.pendingByChannel(),
          },
        };
      },
    },
  };

  // --- HTTP server ---

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // CORS headers for local development
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const handler = routes[method]?.[url];
    if (!handler) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found", path: url }));
      return;
    }

    try {
      let body: unknown = {};
      if (method === "POST") {
        body = await parseJsonBody(req);
      }

      const result = await handler(body);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err instanceof HttpError) {
        res.writeHead(err.status);
        res.end(JSON.stringify({ error: err.message }));
      } else {
        logger.error({ err, method, url }, "Unhandled error in HTTP handler");
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  return server;
}

// --- Helpers ---

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 1_048_576; // 1MB

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new HttpError(413, "Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
