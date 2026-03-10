import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { Bot } from "grammy";

// --- Proxy support (for environments behind a firewall) ---

const HTTP_PROXY = process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY
  ?? process.env.http_proxy ?? process.env.https_proxy;
const proxyAgent = HTTP_PROXY ? new ProxyAgent(HTTP_PROXY) : undefined;
if (HTTP_PROXY) {
  console.log(`[telegram] Will proxy Telegram API via: ${HTTP_PROXY}`);
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
    bot.api.config.use(async (_prev, method, payload) => {
      const url = `https://api.telegram.org/bot${config.bot_token}/${method}`;
      const res = await undiciFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        dispatcher: proxyAgent,
      });
      if (!res.ok) {
        console.error(`[telegram] API error: ${method} -> ${res.status}`);
      }
      return (await res.json()) as ReturnType<typeof _prev>;
    });
    console.log("[telegram] Proxy transformer installed for Grammy API calls");
  }

  // Fetch bot info early so botUsername is available for handlers
  await bot.api.getMe().then((me) => {
    bot.botInfo = me;
    console.log(`[telegram] Bot identity: @${me.username} (id: ${me.id})`);
  });

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

  // --- Helpers ---

  const botUsername = bot.botInfo.username ?? "";

  /** Check user allowlist. Returns true if allowed. */
  function isUserAllowed(userId: number): boolean {
    if (!config.allowed_users || config.allowed_users.length === 0) return true;
    return config.allowed_users.includes(String(userId));
  }

  /** In group chats, only respond when @mentioned or replied to. */
  function isRelevantInGroup(ctx: { chat: { type: string }; message?: { text?: string; caption?: string; reply_to_message?: { from?: { id: number } } } }): boolean {
    if (ctx.chat.type === "private") return true;
    const msg = ctx.message;
    if (!msg) return false;
    // Replied to the bot
    if (msg.reply_to_message?.from?.id === bot.botInfo?.id) return true;
    // @mentioned in text or caption
    const text = msg.text ?? msg.caption ?? "";
    if (botUsername && text.includes(`@${botUsername}`)) return true;
    return false;
  }

  function makeSender(from: { id: number; first_name: string; last_name?: string }) {
    return {
      id: String(from.id),
      name: from.first_name + (from.last_name ? ` ${from.last_name}` : ""),
      channel: "telegram",
    };
  }

  function makeConversation(chat: { id: number; type: string; title?: string }) {
    return {
      id: String(chat.id),
      type: chat.type === "private" ? "dm" as const : "group" as const,
      title: "title" in chat ? (chat as any).title : undefined,
    };
  }

  /** Extract text from a reply_to_message for context. */
  function getReplyContext(msg: { reply_to_message?: { text?: string; caption?: string; from?: { first_name: string; last_name?: string } } }): string {
    const reply = msg.reply_to_message;
    if (!reply) return "";
    const replyText = reply.text ?? reply.caption;
    if (!replyText) return "";
    const who = reply.from
      ? reply.from.first_name + (reply.from.last_name ? ` ${reply.from.last_name}` : "")
      : "Someone";
    return `[Replying to ${who}: "${replyText}"]\n`;
  }

  async function forwardToKernel(payload: Record<string, unknown>) {
    await fetch(`${KERNEL_URL}/api/messages/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  // --- Receive Telegram messages → forward to kernel ---

  bot.on("message:text", async (ctx) => {
    if (!isUserAllowed(ctx.from.id)) return;
    if (!isRelevantInGroup(ctx)) return;

    // Strip @botUsername from text before forwarding
    let text = ctx.message.text;
    if (botUsername) {
      text = text.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();
    }
    const replyContext = getReplyContext(ctx.message);
    text = replyContext + (text || "(mentioned you)");

    // If replying to a photo or sticker, forward as image so the agent can see it
    const reply = ctx.message.reply_to_message;
    const replyImageFileId = reply?.photo?.length
      ? reply.photo[reply.photo.length - 1].file_id
      : reply?.sticker?.file_id ?? null;
    if (replyImageFileId) {
      try {
        const file = await ctx.api.getFile(replyImageFileId);
        const url = `https://api.telegram.org/file/bot${config.bot_token}/${file.file_path}`;
        const payload = {
          id: `tg-${ctx.chat.id}-${ctx.message.message_id}`,
          channel: "telegram",
          sender: makeSender(ctx.from),
          conversation: makeConversation(ctx.chat),
          content: { type: "image" as const, url, caption: text },
          timestamp: ctx.message.date * 1000,
        };
        await forwardToKernel(payload);
        console.log(`[telegram] Forwarded text+reply-image from ${ctx.from.first_name} to kernel`);
        return;
      } catch (err) {
        console.error("[telegram] Failed to get reply image, falling back to text:", err);
      }
    }

    const payload = {
      id: `tg-${ctx.chat.id}-${ctx.message.message_id}`,
      channel: "telegram",
      sender: makeSender(ctx.from),
      conversation: makeConversation(ctx.chat),
      content: { type: "text" as const, text },
      timestamp: ctx.message.date * 1000,
    };

    try {
      await forwardToKernel(payload);
      console.log(`[telegram] Forwarded text from ${ctx.from.first_name} to kernel`);
    } catch (err) {
      console.error("[telegram] Failed to forward message to kernel:", err);
    }
  });

  // --- Photo messages → download URL + forward as image ---

  bot.on("message:photo", async (ctx) => {
    if (!isUserAllowed(ctx.from.id)) return;
    if (!isRelevantInGroup(ctx)) return;

    try {
      // Pick the largest photo (last in the array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      const url = `https://api.telegram.org/file/bot${config.bot_token}/${file.file_path}`;

      const replyContext = getReplyContext(ctx.message);
      let caption = ctx.message.caption ?? "";
      if (botUsername) {
        caption = caption.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();
      }
      caption = replyContext + (caption || "[Sent an image]");

      const payload = {
        id: `tg-${ctx.chat.id}-${ctx.message.message_id}`,
        channel: "telegram",
        sender: makeSender(ctx.from),
        conversation: makeConversation(ctx.chat),
        content: { type: "image" as const, url, caption },
        timestamp: ctx.message.date * 1000,
      };

      await forwardToKernel(payload);
      console.log(`[telegram] Forwarded photo from ${ctx.from.first_name} to kernel`);
    } catch (err) {
      console.error("[telegram] Failed to forward photo to kernel:", err);
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
