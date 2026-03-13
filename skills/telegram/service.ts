import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const HOME = process.env.HOME ?? "/home/codeclaw";
const CONFIG_PATH = process.env.CONFIG_PATH ?? `${HOME}/.claude/config/telegram.json`;
const DATA_DIR = `${HOME}/.claude/data/telegram`;
const KERNEL_URL = process.env.KERNEL_URL ?? "http://localhost:19000";
const SERVICE_PORT = parseInt(process.env.SERVICE_PORT ?? "7001", 10);

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

  console.log(`[telegram] Starting (kernel: ${KERNEL_URL}, port: ${SERVICE_PORT})`);

  // --- JSONL persistence helpers ---

  function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function appendToLog(chatId: string, record: Record<string, unknown>): void {
    ensureDir(DATA_DIR);
    const logPath = join(DATA_DIR, `${chatId}.jsonl`);
    appendFileSync(logPath, JSON.stringify(record) + "\n");
  }

  function saveFile(chatId: string, msgId: string, filename: string, buf: Buffer): { absPath: string; relPath: string } {
    const filesDir = join(DATA_DIR, chatId, "files");
    ensureDir(filesDir);
    const sanitized = filename.replace(/[/\\]/g, "_");
    const safeName = `${msgId}_${sanitized}`;
    const absPath = join(filesDir, safeName);
    writeFileSync(absPath, buf);
    const relPath = `files/${safeName}`;
    return { absPath, relPath };
  }

  // --- Helpers ---

  const botUsername = bot.botInfo.username ?? "";

  /** Check user allowlist. Returns true if allowed. */
  function isUserAllowed(userId: number): boolean {
    if (!config.allowed_users || config.allowed_users.length === 0) return true;
    return config.allowed_users.includes(String(userId));
  }

  /** Check if message directly addresses the bot (@mention or reply-to-bot). */
  function isDirectlyAddressed(ctx: { message?: { text?: string; caption?: string; reply_to_message?: { from?: { id: number } } } }): boolean {
    const msg = ctx.message;
    if (!msg) return false;
    if (msg.reply_to_message?.from?.id === bot.botInfo?.id) return true;
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

  /** Download a Telegram file and return its content as a Buffer. */
  async function downloadTelegramFile(fileId: string): Promise<{ buf: Buffer; filePath: string }> {
    const file = await bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${config.bot_token}/${file.file_path}`;
    const fetchOpts: Record<string, unknown> = {};
    if (proxyAgent) fetchOpts.dispatcher = proxyAgent;
    const res = await undiciFetch(url, fetchOpts as any);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return { buf: Buffer.from(await res.arrayBuffer()), filePath: file.file_path! };
  }

  // --- Active Window: per-group buffering + 3-min conversation window ---

  const ACTIVE_WINDOW_MS = 3 * 60 * 1000;
  const BUFFER_CAPACITY = 50;

  interface BufferedMessage {
    sender: string;
    text: string;
    timestamp: number;
    forwarded: boolean;
  }

  class RingBuffer<T> {
    private items: T[] = [];
    constructor(private capacity: number) {}
    push(item: T): void {
      if (this.items.length >= this.capacity) this.items.shift();
      this.items.push(item);
    }
    getAll(): T[] { return [...this.items]; }
  }

  interface GroupState {
    buffer: RingBuffer<BufferedMessage>;
    activeUntil: number;
  }

  const groupStates = new Map<string, GroupState>();

  function getGroupState(chatId: string): GroupState {
    let state = groupStates.get(chatId);
    if (!state) {
      state = { buffer: new RingBuffer(BUFFER_CAPACITY), activeUntil: 0 };
      groupStates.set(chatId, state);
    }
    return state;
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function buildContextPrefix(messages: BufferedMessage[]): string {
    if (messages.length === 0) return "";
    const lines = messages.map(m => `[${formatTime(m.timestamp)}] ${m.sender}: ${m.text}`);
    return `[Recent group messages (${messages.length} unread)]:\n${lines.join("\n")}\n\n---\n`;
  }

  // --- Unified message handler ---

  bot.on("message", async (ctx) => {
    if (!ctx.from || !isUserAllowed(ctx.from.id)) return;

    const msg = ctx.message;
    const isGroup = ctx.chat.type !== "private";
    const senderName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");

    // Extract summary for ring buffer
    const summary = msg.text
      ?? msg.caption
      ?? (msg.photo ? "[Photo]" : null)
      ?? (msg.document ? `[File: ${msg.document.file_name ?? "unknown"}]` : null)
      ?? (msg.sticker ? `[Sticker${msg.sticker.emoji ? ` ${msg.sticker.emoji}` : ""}]` : null)
      ?? "[Other]";

    // --- Group: buffer + active window logic ---
    let contextPrefix = "";
    if (isGroup) {
      const chatId = String(ctx.chat.id);
      const state = getGroupState(chatId);

      // Always buffer
      state.buffer.push({
        sender: senderName,
        text: summary,
        timestamp: msg.date * 1000,
        forwarded: false,
      });

      const addressed = isDirectlyAddressed(ctx);
      const inWindow = Date.now() < state.activeUntil;

      if (!addressed && !inWindow) return; // Silent buffer

      // Activate or extend window
      const wasInWindow = inWindow;
      state.activeUntil = Date.now() + ACTIVE_WINDOW_MS;

      if (addressed) {
        const unforwarded = state.buffer.getAll().filter(m => !m.forwarded);
        if (unforwarded.length > 0) unforwarded.pop(); // Exclude current message
        contextPrefix = buildContextPrefix(unforwarded);
        console.log(`[telegram] Group ${chatId}: window ${wasInWindow ? "extended" : "started"}, context: ${unforwarded.length} msgs`);
      } else {
        contextPrefix = "[Active window message — reply only if relevant]\n";
        console.log(`[telegram] Group ${chatId}: forwarding in active window`);
      }

      // Mark all buffered as forwarded
      for (const m of state.buffer.getAll()) {
        m.forwarded = true;
      }
    }

    // --- Forward based on message type ---
    const sender = makeSender(ctx.from);
    const conversation = makeConversation(ctx.chat);
    const baseId = `tg_${ctx.chat.id}_${msg.message_id}`;
    const timestamp = msg.date * 1000;

    try {
      if (msg.text != null) {
        // --- Text message ---
        let text = msg.text;
        if (botUsername) {
          text = text.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();
        }
        const replyContext = getReplyContext(msg);
        text = contextPrefix + replyContext + (text || "(mentioned you)");

        // Check if replying to a photo/sticker
        const reply = msg.reply_to_message;
        const replyImageFileId = reply?.photo?.length
          ? reply.photo[reply.photo.length - 1].file_id
          : reply?.sticker?.file_id ?? null;
        if (replyImageFileId) {
          try {
            const file = await ctx.api.getFile(replyImageFileId);
            const url = `https://api.telegram.org/file/bot${config.bot_token}/${file.file_path}`;
            await forwardToKernel({
              id: baseId, channel: "telegram", sender, conversation,
              content: { type: "image" as const, url, caption: text },
              timestamp,
            });
            appendToLog(String(ctx.chat.id), {
              id: baseId, ts: timestamp,
              sender: { id: sender.id, name: sender.name },
              type: "text-reply-image", text: msg.text,
              replyTo: msg.reply_to_message ? `tg_${ctx.chat.id}_${msg.reply_to_message.message_id}` : null,
            });
            console.log(`[telegram] Forwarded text+reply-image from ${senderName}`);
            return;
          } catch (err) {
            console.error("[telegram] Failed to get reply image, falling back to text:", err);
          }
        }

        await forwardToKernel({
          id: baseId, channel: "telegram", sender, conversation,
          content: { type: "text" as const, text },
          timestamp,
        });
        appendToLog(String(ctx.chat.id), {
          id: baseId, ts: timestamp,
          sender: { id: sender.id, name: sender.name },
          type: "text", text: msg.text,
          replyTo: msg.reply_to_message ? `tg_${ctx.chat.id}_${msg.reply_to_message.message_id}` : null,
        });
        console.log(`[telegram] Forwarded text from ${senderName}`);

      } else if (msg.photo) {
        // --- Photo message ---
        const photos = msg.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const url = `https://api.telegram.org/file/bot${config.bot_token}/${file.file_path}`;
        const replyContext = getReplyContext(msg);
        let caption = msg.caption ?? "";
        if (botUsername) {
          caption = caption.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();
        }
        caption = contextPrefix + replyContext + (caption || "[Sent an image]");

        await forwardToKernel({
          id: baseId, channel: "telegram", sender, conversation,
          content: { type: "image" as const, url, caption },
          timestamp,
        });
        // Save photo to disk + JSONL (best effort)
        try {
          const { buf } = await downloadTelegramFile(largest.file_id);
          const ext = file.file_path?.split(".").pop() ?? "jpg";
          const { relPath } = saveFile(String(ctx.chat.id), baseId, `photo.${ext}`, buf);
          appendToLog(String(ctx.chat.id), {
            id: baseId, ts: timestamp,
            sender: { id: sender.id, name: sender.name },
            type: "image", path: relPath,
            caption: (msg.caption ?? "").replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim() || null,
            replyTo: msg.reply_to_message ? `tg_${ctx.chat.id}_${msg.reply_to_message.message_id}` : null,
          });
        } catch { /* best effort logging */ }
        console.log(`[telegram] Forwarded photo from ${senderName}`);

      } else if (msg.document) {
        // --- Document/file message: download and forward as file type ---
        const doc = msg.document;
        const fileName = doc.file_name ?? "unknown";
        const replyContext = getReplyContext(msg);
        let caption = msg.caption ?? "";
        if (botUsername) {
          caption = caption.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();
        }
        const textPart = contextPrefix + replyContext + caption;

        try {
          const { buf } = await downloadTelegramFile(doc.file_id);
          const { absPath, relPath } = saveFile(String(ctx.chat.id), baseId, fileName, buf);

          appendToLog(String(ctx.chat.id), {
            id: baseId, ts: timestamp,
            sender: { id: sender.id, name: sender.name },
            type: "file", filename: fileName, path: relPath,
            size: buf.length, mimeType: doc.mime_type ?? null,
            caption: caption || null,
            replyTo: msg.reply_to_message ? `tg_${ctx.chat.id}_${msg.reply_to_message.message_id}` : null,
          });

          await forwardToKernel({
            id: baseId, channel: "telegram", sender, conversation,
            content: {
              type: "file" as const,
              filename: fileName,
              path: absPath,
              size: buf.length,
              mimeType: doc.mime_type ?? undefined,
            },
            timestamp,
            ...(textPart.trim() ? { caption: textPart.trim() } : {}),
          });
          console.log(`[telegram] Saved file "${fileName}" (${buf.length}B) to ${absPath}`);
        } catch (err) {
          console.error(`[telegram] Failed to download file "${fileName}":`, err);
          // Fallback: send text notification without file data
          await forwardToKernel({
            id: baseId, channel: "telegram", sender, conversation,
            content: { type: "text" as const, text: textPart + `[File: ${fileName} — download failed]` },
            timestamp,
          });
        }

      } else if (isGroup) {
        // Sticker, audio, etc. — buffered for context but not forwarded to agent
        console.log(`[telegram] Buffered ${msg.sticker ? "sticker" : "media"} from ${senderName} (context only)`);
      }
    } catch (err) {
      console.error("[telegram] Failed to process message:", err);
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
            const idPart = replyTo.startsWith("tg_") ? replyTo.split("_").pop() : replyTo;
            const parsed = idPart ? parseInt(idPart, 10) : NaN;
            if (!isNaN(parsed)) replyMsgId = parsed;
          }

          await bot.api.sendMessage(conversation, content.text, {
            ...(replyMsgId ? { reply_parameters: { message_id: replyMsgId } } : {}),
          });

          // Log outbound message to JSONL
          appendToLog(conversation, {
            id: `tg_${conversation}_out_${Date.now()}`,
            ts: Date.now(),
            sender: { id: "bot", name: "Agent" },
            type: "text", text: content.text,
            replyTo: replyTo ?? null,
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

  // Graceful shutdown (unregister handled by framework)
  const shutdown = () => {
    console.log("[telegram] Shutting down...");
    bot.stop();
    httpServer.close();
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
