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
const DATA_BASE = `${HOME}/.claude/data/telegram`;
const PREVIEW_LIMIT = 200;
const KERNEL_URL = process.env.KERNEL_URL ?? "http://localhost:19000";
const AGENT_ID = process.env.AGENT_ID;
const SERVICE_PORT = parseInt(process.env.SERVICE_PORT ?? "7001", 10);

function loadConfig(): TelegramConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw) as TelegramConfig;
  if (!config.bot_token) {
    throw new Error("bot_token is required in telegram config");
  }
  return config;
}

// --- Date-based JSONL storage + seq tracking ---

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getJsonlPath(chatId: string, date?: string): string {
  const dir = join(DATA_BASE, date ?? todayStr());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${chatId}.jsonl`);
}

function getFilesDir(chatId: string, date?: string): string {
  const dir = join(DATA_BASE, date ?? todayStr(), chatId, "files");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const seqCounters = new Map<string, { date: string; seq: number }>();

function nextSeq(chatId: string, date?: string): number {
  const targetDate = date ?? todayStr();
  const key = `${chatId}:${targetDate}`;
  const entry = seqCounters.get(key);
  if (entry && entry.date === targetDate) {
    return ++entry.seq;
  }
  const path = getJsonlPath(chatId, targetDate);
  let startSeq = 0;
  if (existsSync(path)) {
    const content = readFileSync(path, "utf-8").trimEnd();
    if (content) {
      const lastLine = content.split("\n").pop()!;
      try { startSeq = JSON.parse(lastLine).seq + 1; }
      catch { startSeq = content.split("\n").length; }
    }
  }
  seqCounters.set(key, { date: targetDate, seq: startSeq });
  return startSeq;
}

function appendToLog(chatId: string, record: Record<string, unknown>, date?: string): number {
  const seq = nextSeq(chatId, date);
  const path = getJsonlPath(chatId, date);
  appendFileSync(path, JSON.stringify({ seq, ...record }) + "\n");
  return seq;
}

function saveFile(chatId: string, filename: string, buf: Buffer): { absPath: string; relPath: string } {
  const dir = getFilesDir(chatId);
  const sanitized = filename.replace(/[/\\]/g, "_");
  const absPath = join(dir, sanitized);
  writeFileSync(absPath, buf);
  return { absPath, relPath: `${chatId}/files/${sanitized}` };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Detect image type from magic bytes. */
function detectImageType(buf: Buffer): string {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  return "image/jpeg"; // fallback
}

/** Truncate by Unicode code points to avoid splitting surrogate pairs. */
function safeSlice(s: string, maxCodePoints: number): string {
  const chars = [...s];
  if (chars.length <= maxCodePoints) return s;
  return chars.slice(0, maxCodePoints).join("");
}

/** Build notification header for agent. Embeds all metadata in text. */
function buildNotificationHeader(
  chatId: string,
  senderName: string,
  seq: number,
  tgMsgId: number,
  replyRef?: string,
): string {
  const date = todayStr();
  const time = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Shanghai", hour12: false });
  const replyTag = replyRef ? ` reply-to:${replyRef}` : "";
  return `[telegram/${chatId}] ${senderName} (${date} ${time} seq:${seq} msgId:${tgMsgId}${replyTag}):\n  -> ~/.claude/data/telegram/${date}/${chatId}.jsonl`;
}

// --- ensureReplyPersisted ---

/** In-memory index of persisted tgMsgIds per chat+date. Avoids full JSONL scan on every reply. */
const persistedMsgIds = new Map<string, Set<number>>();

function getPersistedSet(chatId: string, date: string): Set<number> {
  const key = `${chatId}:${date}`;
  let set = persistedMsgIds.get(key);
  if (!set) {
    set = new Set<number>();
    const path = getJsonlPath(chatId, date);
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf-8").trimEnd().split("\n")) {
        try { const id = JSON.parse(line).tgMsgId; if (id != null) set.add(id); } catch { /* skip */ }
      }
    }
    persistedMsgIds.set(key, set);
  }
  return set;
}

/**
 * Ensure a reply-to message is persisted in today's JSONL.
 * Returns a reference string for the notification header.
 * Only persists metadata; does not download binary files.
 */
function ensureReplyPersisted(
  chatId: string,
  replyMsg: { message_id: number; date: number; from?: { id: number; first_name: string; last_name?: string }; text?: string; caption?: string; photo?: unknown[]; sticker?: { emoji?: string; set_name?: string; file_id: string }; document?: { file_name?: string; mime_type?: string }; voice?: unknown; audio?: unknown },
): string {
  const tgMsgId = replyMsg.message_id;
  // Use the original message's date, not today
  const msgDate = new Date(replyMsg.date * 1000);
  const dateStr = `${msgDate.getFullYear()}-${String(msgDate.getMonth() + 1).padStart(2, "0")}-${String(msgDate.getDate()).padStart(2, "0")}`;

  // Check in-memory index (populated lazily from JSONL on first access)
  const knownIds = getPersistedSet(chatId, dateStr);
  if (knownIds.has(tgMsgId)) return `${dateStr}/${chatId}/tgMsgId:${tgMsgId}`;

  // Not found — persist metadata
  const senderName = replyMsg.from
    ? replyMsg.from.first_name + (replyMsg.from.last_name ? ` ${replyMsg.from.last_name}` : "")
    : "Unknown";
  const logRecord: Record<string, unknown> = {
    ts: replyMsg.date * 1000,
    tgMsgId,
    sender: { id: String(replyMsg.from?.id ?? 0), name: senderName },
    persisted: "reply-ref",
  };

  if (replyMsg.text) {
    logRecord.type = "text";
    logRecord.text = replyMsg.text;
  } else if (replyMsg.caption) {
    logRecord.type = "text";
    logRecord.text = replyMsg.caption;
  } else if (replyMsg.photo) {
    logRecord.type = "image";
    logRecord.caption = replyMsg.caption ?? null;
  } else if (replyMsg.sticker) {
    logRecord.type = "sticker";
    logRecord.emoji = replyMsg.sticker.emoji ?? null;
    logRecord.setName = replyMsg.sticker.set_name ?? null;
  } else if (replyMsg.document) {
    logRecord.type = "file";
    logRecord.filename = replyMsg.document.file_name ?? null;
  } else if (replyMsg.voice || replyMsg.audio) {
    logRecord.type = "audio";
  } else {
    logRecord.type = "other";
  }

  appendToLog(chatId, logRecord, dateStr);
  knownIds.add(tgMsgId);
  return `${dateStr}/${chatId}/tgMsgId:${tgMsgId}`;
}

// --- 401 Circuit Breaker for sendChatAction ---

class ChatActionCircuitBreaker {
  private consecutive401 = 0;
  private suspended = false;
  private backoffUntil = 0;

  constructor(private maxFailures = 10) {}

  shouldSkip(): boolean {
    if (this.suspended) return true;
    if (this.consecutive401 > 0 && Date.now() < this.backoffUntil) return true;
    return false;
  }

  recordSuccess(): void {
    if (this.consecutive401 > 0) {
      console.log(`[telegram] sendChatAction recovered after ${this.consecutive401} consecutive 401s`);
    }
    this.consecutive401 = 0;
  }

  recordError(err: unknown): void {
    const is401 = (err as any)?.error_code === 401 ||
      (err instanceof Error && (err.message.includes("401") || err.message.toLowerCase().includes("unauthorized")));
    if (!is401) return;
    this.consecutive401++;
    const backoffMs = Math.min(1000 * 2 ** (this.consecutive401 - 1), 300_000);
    this.backoffUntil = Date.now() + backoffMs;
    if (this.consecutive401 >= this.maxFailures) {
      this.suspended = true;
      console.error(
        `[telegram] CRITICAL: sendChatAction suspended after ${this.consecutive401} consecutive 401 errors. ` +
        `Bot token may be invalid. Restart the skill after fixing the token.`,
      );
    } else {
      console.warn(`[telegram] sendChatAction 401 (${this.consecutive401}/${this.maxFailures}), backoff ${backoffMs}ms`);
    }
  }
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

  // Register command menu with Telegram (visible in input field autocomplete)
  await bot.api.setMyCommands([
    { command: "status", description: "Kernel status, uptime, queue" },
    { command: "help", description: "Show available commands" },
    { command: "model", description: "Switch model" },
    { command: "interrupt", description: "Stop current task" },
    { command: "cost", description: "Show session API cost" },
    { command: "session", description: "List / switch sessions" },
    { command: "compact", description: "Compress conversation context" },
  ]).then(() => console.log("[telegram] Command menu registered"))
    .catch((err) => console.error("[telegram] Failed to register command menu:", err));

  console.log(`[telegram] Starting (kernel: ${KERNEL_URL}, port: ${SERVICE_PORT})`);

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

  /** Watch map: chatId → expiry timestamp. Group messages are forwarded while watched. */
  const DEFAULT_WATCH_MINUTES = 3;
  const watchMap = new Map<string, number>();

  function isWatched(chatId: string): boolean {
    const expiry = watchMap.get(chatId);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      watchMap.delete(chatId);
      return false;
    }
    return true;
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

  const chatActionBreaker = new ChatActionCircuitBreaker();

  // --- Skill-level slash command handler ---

  async function handleSkillCommand(cmd: string, args: string, chatId: string, replyToMsgId: number) {
    try {
      if (cmd === "/status") {
        // Query Kernel status
        let statusText: string;
        try {
          const res = await fetch(`${KERNEL_URL}/api/status`);
          const data = await res.json() as {
            uptime: number;
            services: Record<string, unknown>;
            queue: { pending: number };
          };
          const uptimeMin = Math.floor(data.uptime / 60000);
          const serviceList = Object.keys(data.services);
          statusText = [
            `Uptime: ${uptimeMin}m`,
            `Queue: ${data.queue.pending} pending`,
            `Skills: ${serviceList.length > 0 ? serviceList.join(", ") : "none"}`,
          ].join("\n");
        } catch {
          statusText = "Cannot reach Kernel";
        }
        await bot.api.sendMessage(chatId, statusText, {
          reply_parameters: { message_id: replyToMsgId },
        });

      } else if (cmd === "/start") {
        // Telegram bot init command — just greet, don't forward to Agent
        await bot.api.sendMessage(chatId, "Hello! Send me a message to get started.", {
          reply_parameters: { message_id: replyToMsgId },
        });

      } else if (cmd === "/help") {
        const helpText = [
          "Skill commands (instant):",
          "  /status — Kernel status, uptime, queue",
          "  /help — This message",
          "",
          "Agent commands (routed to runtime):",
          "  /model <name> — Switch model",
          "  /interrupt — Stop current task",
          "  /cost — Show accumulated API cost",
          "  /session — List recent sessions",
          "  /session new — Start fresh session",
          "  /session <id> — Resume session by ID prefix",
          "",
          "SDK commands (routed to Claude Code):",
          "  /compact — Compress conversation context",
          "  /review — Code review",
          "  /simplify — Review code for quality",
          "  /context — Show context info",
        ].join("\n");
        await bot.api.sendMessage(chatId, helpText, {
          reply_parameters: { message_id: replyToMsgId },
        });
      }
    } catch (err) {
      console.error(`[telegram] handleSkillCommand(${cmd}) error:`, err);
    }
  }

  // --- Unified message handler ---

  bot.on("message", async (ctx) => {
    if (!ctx.from || !isUserAllowed(ctx.from.id)) return;

    const msg = ctx.message;
    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type !== "private";
    const sender = makeSender(ctx.from);
    const conversation = makeConversation(ctx.chat);
    const tgMsgId = msg.message_id;
    const timestamp = msg.date * 1000;

    // --- Handle reply-to: ensure persisted, get reference ---
    let replyRef: string | undefined;
    if (msg.reply_to_message) {
      replyRef = ensureReplyPersisted(chatId, msg.reply_to_message as any);
    }

    // --- Persist + build kernel content ---
    const logBase: Record<string, unknown> = {
      ts: timestamp,
      tgMsgId,
      sender: { id: sender.id, name: sender.name },
      ...(msg.reply_to_message ? { replyToTgMsgId: msg.reply_to_message.message_id } : {}),
    };

    // kernelContent: what gets sent to Kernel (always text or image)
    let kernelContent: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string; caption: string } | null = null;
    let seq: number;

    try {
      if (msg.text != null) {
        let text = msg.text;
        if (botUsername) text = text.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();
        text = text || "(empty)";

        // --- Slash command detection ---
        if (text.startsWith("/")) {
          const parts = text.split(/\s+/);
          const cmd = parts[0].toLowerCase();
          const args = parts.slice(1).join(" ");

          // Skill-level commands: handle locally, don't forward to Agent
          if (cmd === "/start" || cmd === "/status" || cmd === "/help") {
            await handleSkillCommand(cmd, args, chatId, tgMsgId);
            return;
          }

          // Other commands: forward to Kernel with metadata.command
          // Use raw command text as content (no notification header) so downstream
          // layers can identify and route it. Channel/conversation info is in the
          // InboundMessage fields, not needed in content text.
          seq = appendToLog(chatId, { ...logBase, type: "text", text: msg.text });
          kernelContent = { type: "text", text };

          try {
            await forwardToKernel({
              id: `tg_${chatId}_${tgMsgId}`,
              channel: "telegram",
              agentId: AGENT_ID,
              sender,
              conversation,
              content: kernelContent,
              timestamp,
              metadata: { command: cmd, args, raw: text },
            });
            console.log(`[telegram] Forwarded command ${cmd} from ${sender.name}`);
          } catch (err) {
            console.error("[telegram] Failed to forward command:", err);
          }
          return;
        }

        // --- Normal text message handling ---
        seq = appendToLog(chatId, { ...logBase, type: "text", text: msg.text });
        const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, replyRef);

        if (text.length <= PREVIEW_LIMIT) {
          kernelContent = { type: "text", text: `${header}\n${text}` };
        } else {
          kernelContent = { type: "text", text: `${header}\n${safeSlice(text, 100)}...\n  (full text in JSONL at seq:${seq})` };
        }

      } else if (msg.photo) {
        const largest = msg.photo[msg.photo.length - 1];
        let caption = msg.caption ?? "";
        if (botUsername) caption = caption.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();

        try {
          const { buf } = await downloadTelegramFile(largest.file_id);
          const mimeType = detectImageType(buf);
          const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
          const { relPath } = saveFile(chatId, `${tgMsgId}_photo.${ext}`, buf);
          seq = appendToLog(chatId, { ...logBase, type: "image", fileId: largest.file_id, path: relPath, caption: caption || null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, replyRef);
          kernelContent = { type: "image", data: buf.toString("base64"), mimeType, caption: `${header}${caption ? `\n${caption}` : ""}` };
        } catch (err) {
          console.error("[telegram] Failed to download photo:", err);
          seq = appendToLog(chatId, { ...logBase, type: "image", fileId: largest.file_id, caption: caption || null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, replyRef);
          kernelContent = { type: "text", text: `${header}\n[图片${caption ? `: ${caption}` : ""}]` };
        }

      } else if (msg.sticker) {
        const sticker = msg.sticker;
        const isStatic = !sticker.is_animated && !sticker.is_video;
        const emojiLabel = sticker.emoji ? ` ${sticker.emoji}` : "";
        const setLabel = sticker.set_name ? ` 来自 ${sticker.set_name}` : "";

        try {
          const { buf } = await downloadTelegramFile(sticker.file_id);
          const ext = sticker.is_animated ? "tgs" : sticker.is_video ? "webm" : "webp";
          const { relPath } = saveFile(chatId, `${tgMsgId}_sticker.${ext}`, buf);
          seq = appendToLog(chatId, { ...logBase, type: "sticker", fileId: sticker.file_id, path: relPath, emoji: sticker.emoji ?? null, setName: sticker.set_name ?? null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, replyRef);

          if (isStatic) {
            kernelContent = { type: "image", data: buf.toString("base64"), mimeType: "image/webp", caption: `${header}\n[贴纸${emojiLabel}]` };
          } else {
            kernelContent = { type: "text", text: `${header}\n[贴纸${emojiLabel}${setLabel}]` };
          }
        } catch {
          seq = appendToLog(chatId, { ...logBase, type: "sticker", fileId: sticker.file_id, emoji: sticker.emoji ?? null, setName: sticker.set_name ?? null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, replyRef);
          kernelContent = { type: "text", text: `${header}\n[贴纸${emojiLabel}]` };
        }

      } else if (msg.document) {
        const doc = msg.document;
        const fileName = doc.file_name ?? "unknown";
        let caption = msg.caption ?? "";
        if (botUsername) caption = caption.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();

        try {
          const { buf } = await downloadTelegramFile(doc.file_id);
          const { relPath } = saveFile(chatId, `${tgMsgId}_${fileName}`, buf);
          seq = appendToLog(chatId, { ...logBase, type: "file", filename: fileName, path: relPath, size: buf.length, mimeType: doc.mime_type ?? null, caption: caption || null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, replyRef);
          kernelContent = { type: "text", text: `${header}\n[文件: ${fileName}, ${formatSize(buf.length)}${caption ? `, "${caption}"` : ""}]` };
        } catch {
          seq = appendToLog(chatId, { ...logBase, type: "file", filename: fileName, mimeType: doc.mime_type ?? null, caption: caption || null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, replyRef);
          kernelContent = { type: "text", text: `${header}\n[文件: ${fileName}${caption ? `, "${caption}"` : ""}]` };
        }

      } else if (msg.voice || msg.audio) {
        const audio = msg.voice ?? msg.audio!;
        const durStr = audio.duration ? `, ${audio.duration}秒` : "";

        try {
          const { buf } = await downloadTelegramFile(audio.file_id);
          const ext = msg.voice ? "ogg" : "mp3";
          const { relPath } = saveFile(chatId, `${tgMsgId}_audio.${ext}`, buf);
          seq = appendToLog(chatId, { ...logBase, type: "audio", path: relPath, duration: audio.duration ?? null });
        } catch {
          seq = appendToLog(chatId, { ...logBase, type: "audio", duration: audio.duration ?? null });
        }
        const header = buildNotificationHeader(chatId, sender.name, seq!, tgMsgId, replyRef);
        kernelContent = { type: "text", text: `${header}\n[语音消息${durStr}]` };

      } else {
        seq = appendToLog(chatId, { ...logBase, type: "other" });
        const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, replyRef);
        kernelContent = { type: "text", text: `${header}\n[不支持的消息类型]` };
      }
    } catch (err) {
      console.error("[telegram] Failed to process message:", err);
      return;
    }

    // --- Group: only forward if directly addressed or watched ---
    if (isGroup && !isDirectlyAddressed(ctx) && !isWatched(chatId)) return;

    // Auto-start watch window when directly addressed in group
    if (isGroup && isDirectlyAddressed(ctx)) {
      watchMap.set(chatId, Date.now() + DEFAULT_WATCH_MINUTES * 60_000);
    }
    if (!kernelContent) return;

    // --- Forward standard InboundMessage to Kernel (no extra fields) ---
    try {
      await forwardToKernel({
        id: `tg_${chatId}_${tgMsgId}`,
        channel: "telegram",
        agentId: AGENT_ID,
        sender,
        conversation,
        content: kernelContent,
        timestamp,
      });
      console.log(`[telegram] Forwarded ${kernelContent.type} from ${sender.name} (seq:${seq!})`);
    } catch (err) {
      console.error("[telegram] Failed to forward to kernel:", err);
    }
  });

  // --- HTTP server: kernel sends outbound messages here ---

  function sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/send") {
      try {
        const body = await parseBody(req);
        const { conversation, content, replyTo, progress } = body as {
          conversation: string;
          content: { type: string; text: string };
          replyTo?: string;
          progress?: boolean;
        };

        if (content.type === "text") {
          // Parse replyTo: handles both raw IDs and composite "tg-chatId-msgId" format
          let replyMsgId: number | undefined;
          if (replyTo) {
            const idPart = replyTo.startsWith("tg_") ? replyTo.split("_").pop() : replyTo;
            const parsed = idPart ? parseInt(idPart, 10) : NaN;
            if (!isNaN(parsed)) replyMsgId = parsed;
          }

          const sent = await bot.api.sendMessage(conversation, content.text, {
            ...(replyMsgId ? { reply_parameters: { message_id: replyMsgId } } : {}),
          });

          // Skip JSONL for progress messages (ephemeral)
          if (!progress) {
            const outSeq = appendToLog(conversation, {
              ts: Date.now(),
              tgMsgId: sent.message_id,
              sender: { id: "bot", name: "Agent" },
              type: "text",
              text: content.text,
              ...(replyMsgId ? { replyToTgMsgId: replyMsgId } : {}),
            });
            sendJson(res, 200, { success: true, messageId: sent.message_id, seq: outSeq });
          } else {
            sendJson(res, 200, { success: true, messageId: sent.message_id });
          }

          return;
        }

        sendJson(res, 400, { error: `Unsupported content type: ${content.type}` });
      } catch (err) {
        console.error("[telegram] Failed to send outbound message:", err);
        sendJson(res, 500, { error: String(err) });
      }

    } else if (req.method === "POST" && req.url === "/edit") {
      try {
        const body = await parseBody(req);
        const { conversation, messageId, text } = body as {
          conversation: string;
          messageId: number;
          text: string;
        };
        await bot.api.editMessageText(conversation, messageId, text);
        sendJson(res, 200, { success: true });
      } catch (err) {
        console.error("[telegram] Failed to edit message:", err);
        sendJson(res, 500, { error: String(err) });
      }

    } else if (req.method === "POST" && req.url === "/action") {
      try {
        const body = await parseBody(req);
        const { conversation, action } = body as { conversation: string; action: string };
        if (!chatActionBreaker.shouldSkip()) {
          try {
            await bot.api.sendChatAction(conversation, action as any);
            chatActionBreaker.recordSuccess();
          } catch (err) {
            chatActionBreaker.recordError(err);
          }
        }
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 400, { error: String(err) });
      }

    } else if (req.method === "POST" && req.url === "/react") {
      try {
        const body = await parseBody(req);
        const { conversation, messageId, emoji, remove } = body as {
          conversation: string; messageId: number; emoji: string; remove?: boolean;
        };
        const reaction = remove || !emoji ? [] : [{ type: "emoji" as const, emoji } as const];
        await bot.api.setMessageReaction(conversation, messageId, reaction as any);
        sendJson(res, 200, { success: true });
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("REACTION_INVALID")) {
          sendJson(res, 400, { error: `Unsupported Telegram reaction emoji. ${errStr}` });
        } else {
          console.error("[telegram] Failed to set reaction:", err);
          sendJson(res, 500, { error: errStr });
        }
      }

    } else if (req.method === "POST" && req.url === "/delete") {
      try {
        const body = await parseBody(req);
        const { conversation, messageId } = body as { conversation: string; messageId: number };
        await bot.api.deleteMessage(conversation, messageId);
        sendJson(res, 200, { success: true });
      } catch (err) {
        console.error("[telegram] Failed to delete message:", err);
        sendJson(res, 500, { error: String(err) });
      }

    } else if (req.method === "POST" && req.url === "/sticker") {
      try {
        const body = await parseBody(req);
        const { conversation, fileId, replyTo } = body as {
          conversation: string; fileId: string; replyTo?: number;
        };
        const sent = await bot.api.sendSticker(conversation, fileId, {
          ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
        });
        appendToLog(conversation, {
          ts: Date.now(),
          tgMsgId: sent.message_id,
          sender: { id: "bot", name: "Agent" },
          type: "sticker", fileId,
          ...(replyTo ? { replyToTgMsgId: replyTo } : {}),
        });
        sendJson(res, 200, { success: true, messageId: sent.message_id });
      } catch (err) {
        console.error("[telegram] Failed to send sticker:", err);
        sendJson(res, 500, { error: String(err) });
      }

    } else if (req.method === "POST" && req.url === "/sticker_set") {
      try {
        const body = await parseBody(req);
        const { name, offset, limit } = body as {
          name: string; offset?: number; limit?: number;
        };
        const set = await bot.api.getStickerSet(name);
        const start = offset ?? 0;
        const safeLimit = Math.min(limit ?? 10, 20);
        const end = start + safeLimit;
        const page = set.stickers.slice(start, end);

        const stickerCacheDir = join(DATA_BASE, "stickers", name);
        if (!existsSync(stickerCacheDir)) mkdirSync(stickerCacheDir, { recursive: true });

        const stickers = await Promise.all(page.map(async (s, i) => {
          const entry: Record<string, unknown> = {
            index: start + i,
            fileId: s.file_id,
            emoji: s.emoji ?? null,
            isAnimated: s.is_animated ?? false,
            isVideo: s.is_video ?? false,
          };
          // Static stickers: use thumbnail or full file; animated/video: use thumbnail only
          const thumbFileId = s.thumbnail?.file_id ?? (!s.is_animated && !s.is_video ? s.file_id : null);
          if (thumbFileId) {
            const cachePath = join(stickerCacheDir, `${thumbFileId}.webp`);
            try {
              let buf: Buffer;
              if (existsSync(cachePath)) {
                buf = readFileSync(cachePath);
              } else {
                ({ buf } = await downloadTelegramFile(thumbFileId));
                writeFileSync(cachePath, buf);
              }
              entry.thumbnail = buf.toString("base64");
              entry.mimeType = "image/webp";
            } catch { /* skip thumbnail on error */ }
          }
          return entry;
        }));

        sendJson(res, 200, {
          success: true, name: set.name, title: set.title,
          total: set.stickers.length, offset: start, count: stickers.length,
          stickers,
        });
      } catch (err) {
        console.error("[telegram] Failed to get sticker set:", err);
        sendJson(res, 500, { error: String(err) });
      }

    } else if (req.method === "POST" && req.url === "/poll") {
      try {
        const body = await parseBody(req);
        const { conversation, question, options, isAnonymous, allowsMultiple } = body as {
          conversation: string; question: string; options: string[];
          isAnonymous?: boolean; allowsMultiple?: boolean;
        };
        const sent = await bot.api.sendPoll(conversation, question, options, {
          is_anonymous: isAnonymous ?? true,
          allows_multiple_answers: allowsMultiple ?? false,
        });
        sendJson(res, 200, { success: true, messageId: sent.message_id, pollId: sent.poll!.id });
      } catch (err) {
        console.error("[telegram] Failed to send poll:", err);
        sendJson(res, 500, { error: String(err) });
      }

    } else if (req.method === "POST" && req.url === "/get_message") {
      try {
        const body = await parseBody(req);
        const { conversation, date, seq, messageId } = body as {
          conversation: string; date: string; seq?: number; messageId?: number;
        };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^-?\d+$/.test(conversation)) {
          sendJson(res, 400, { error: "Invalid date or conversation format" });
          return;
        }
        const filePath = join(DATA_BASE, date, `${conversation}.jsonl`);
        if (!existsSync(filePath)) {
          sendJson(res, 404, { error: "JSONL file not found" });
          return;
        }
        const lines = readFileSync(filePath, "utf-8").trimEnd().split("\n");

        let record: Record<string, unknown> | null = null;
        if (seq != null && seq < lines.length) {
          // O(1) lookup: seq N is line N
          try { record = JSON.parse(lines[seq]); } catch { /* fallthrough to scan */ }
        }
        if (!record) {
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (seq != null && parsed.seq === seq) { record = parsed; break; }
            if (messageId != null && parsed.tgMsgId === messageId) { record = parsed; break; }
          }
        }

        if (!record) {
          sendJson(res, 404, { error: "Message not found" });
          return;
        }

        // Package saved files as base64 attachments
        const attachments: { mimeType: string; data: string }[] = [];
        if (record.path && typeof record.path === "string") {
          if ((record.path as string).includes("..")) {
            sendJson(res, 400, { error: "Invalid path in record" });
            return;
          }
          const absPath = join(DATA_BASE, date, record.path as string);
          if (existsSync(absPath)) {
            const buf = readFileSync(absPath);
            const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
            const mimeMap: Record<string, string> = {
              jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
              webp: "image/webp", gif: "image/gif", ogg: "audio/ogg",
              mp3: "audio/mpeg", webm: "video/webm",
            };
            attachments.push({ mimeType: mimeMap[ext] ?? "application/octet-stream", data: buf.toString("base64") });
          }
        }

        sendJson(res, 200, { success: true, message: record, attachments });
      } catch (err) {
        console.error("[telegram] Failed to get message:", err);
        sendJson(res, 500, { error: String(err) });
      }

    } else if (req.method === "POST" && req.url === "/watch") {
      try {
        const body = await parseBody(req);
        const { conversation, minutes } = body as { conversation: string; minutes?: number };
        const dur = Math.max(0, Math.min(minutes ?? 3, 1440)); // cap at 24h
        if (dur === 0) {
          watchMap.delete(conversation);
          console.log(`[telegram] Stopped watching ${conversation}`);
        } else {
          watchMap.set(conversation, Date.now() + dur * 60_000);
          console.log(`[telegram] Watching ${conversation} for ${dur}m`);
        }
        sendJson(res, 200, { success: true, conversation, minutes: dur });
      } catch (err) {
        sendJson(res, 400, { error: String(err) });
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
