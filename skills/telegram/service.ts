import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { Bot } from "grammy";

// --- Proxy support (for environments behind a firewall) ---

const HTTPS_PROXY = process.env.https_proxy ?? process.env.HTTPS_PROXY;
const proxyAgent = HTTPS_PROXY ? new ProxyAgent(HTTPS_PROXY) : undefined;
if (HTTPS_PROXY) {
  console.log(`[telegram] Will proxy Telegram API via: ${HTTPS_PROXY}`);
}

// --- Configuration ---

interface TelegramConfig {
  bot_token: string;
  allowed_users?: string[];
}

const CONFIG_PATH = process.env.CONFIG_PATH ?? "/workspace/config/telegram.json";
const KERNEL_URL = process.env.KERNEL_URL ?? "http://host.docker.internal:19000";
const SERVICE_PORT = parseInt(process.env.SERVICE_PORT ?? "7001", 10);
const SKILL_ID = process.env.SKILL_ID ?? "telegram";

function loadConfig(): TelegramConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw) as TelegramConfig;
  if (!config.bot_token) {
    throw new Error("bot_token is required in telegram config");
  }
  return config;
}

// --- Main ---

async function main() {
  const config = loadConfig();
  const bot = new Bot(config.bot_token);

  // Install proxy transformer for all Grammy API calls
  if (proxyAgent) {
    bot.api.config.use(async (prev, method, payload, signal) => {
      const url = `https://api.telegram.org/bot${config.bot_token}/${method}`;
      const res = await undiciFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        dispatcher: proxyAgent,
      });
      return (await res.json()) as ReturnType<typeof prev>;
    });
    console.log("[telegram] Proxy transformer installed for Grammy API calls");
  }

  console.log(`[telegram] Starting with kernel at ${KERNEL_URL}`);

  // Register with kernel I/O Bridge
  const regRes = await fetch(`${KERNEL_URL}/api/services/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skillId: SKILL_ID,
      type: "channel",
      capabilities: ["send_message", "receive_message"],
      endpoint: `http://localhost:${SERVICE_PORT}`,
    }),
  });

  if (!regRes.ok) {
    throw new Error(`Failed to register with kernel: ${regRes.status} ${await regRes.text()}`);
  }
  console.log("[telegram] Registered with kernel I/O Bridge");

  // --- Receive Telegram messages → forward to kernel ---

  bot.on("message:text", async (ctx) => {
    // Check user allowlist
    if (config.allowed_users && config.allowed_users.length > 0) {
      if (!config.allowed_users.includes(String(ctx.from.id))) {
        console.log(`[telegram] Ignoring message from non-allowed user: ${ctx.from.id}`);
        return;
      }
    }

    const payload = {
      id: `tg-${ctx.chat.id}-${ctx.message.message_id}`,
      channel: "telegram",
      sender: {
        id: String(ctx.from.id),
        name: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ""),
        channel: "telegram",
      },
      conversation: {
        id: String(ctx.chat.id),
        type: ctx.chat.type === "private" ? "dm" as const : "group" as const,
        title: "title" in ctx.chat ? ctx.chat.title : undefined,
      },
      content: { type: "text" as const, text: ctx.message.text },
      timestamp: ctx.message.date * 1000,
    };

    try {
      await fetch(`${KERNEL_URL}/api/messages/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`[telegram] Forwarded message from ${ctx.from.first_name} to kernel`);
    } catch (err) {
      console.error("[telegram] Failed to forward message to kernel:", err);
    }
  });

  // --- HTTP server: kernel sends outbound messages here ---

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/send") {
      try {
        const body = await parseBody(req);
        const { conversation, content, replyTo } = body as {
          conversation: string;
          content: { type: string; text: string };
          replyTo?: string;
        };

        if (content.type === "text") {
          // Parse replyTo: handles both raw IDs and composite "tg-chatId-msgId" format
          let replyMsgId: number | undefined;
          if (replyTo) {
            const idPart = replyTo.startsWith("tg-") ? replyTo.split("-").pop() : replyTo;
            const parsed = idPart ? parseInt(idPart, 10) : NaN;
            if (!isNaN(parsed)) replyMsgId = parsed;
          }

          await bot.api.sendMessage(conversation, content.text, {
            ...(replyMsgId ? { reply_parameters: { message_id: replyMsgId } } : {}),
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error("[telegram] Failed to send outbound message:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  httpServer.listen(SERVICE_PORT, () => {
    console.log(`[telegram] HTTP endpoint listening on port ${SERVICE_PORT}`);
  });

  // Start the bot
  bot.start({
    onStart: () => {
      console.log("[telegram] Bot started and polling for messages");
    },
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[telegram] Shutting down...");
    bot.stop();
    httpServer.close();

    // Unregister from kernel
    fetch(`${KERNEL_URL}/api/services/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId: SKILL_ID }),
    }).catch(() => {});

    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// --- Helpers ---

const MAX_BODY_BYTES = 1_048_576; // 1MB

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error("[telegram] Fatal error:", err);
  process.exit(1);
});
