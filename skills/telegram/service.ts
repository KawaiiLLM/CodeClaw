import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { Bot, InlineKeyboard, InputFile } from "grammy";

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

const MODEL_OPTIONS = [
  { label: "Opus 4", id: "aws-claude-opus-4-6" },
  { label: "Sonnet 4", id: "aws-claude-sonnet-4-6" },
  { label: "Haiku 4", id: "aws-claude-haiku-4-5" },
];

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

interface ReplyContent {
  ref: string;
  preview: string;
  image?: { data: string; mimeType: string };
}

/** Build notification header for agent. Embeds all metadata in text. */
function buildNotificationHeader(
  chatId: string,
  senderName: string,
  seq: number,
  tgMsgId: number,
  opts?: { reply?: ReplyContent; mentioned?: boolean },
): string {
  const date = todayStr();
  const time = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Shanghai", hour12: false });
  const mentionTag = opts?.mentioned != null ? ` mentioned:${opts.mentioned}` : "";
  let header = `[telegram/${chatId}] ${senderName} (${date} ${time} seq:${seq} msgId:${tgMsgId}${mentionTag})`;
  if (opts?.reply) {
    header += `\n  reply-to:${opts.reply.ref}`;
    header += `\n  > ${opts.reply.preview}`;
  }
  header += `\n  -> ~/.claude/data/telegram/${date}/${chatId}.jsonl`;
  return header;
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

  // Re-register with Kernel to add botUsername metadata for cross-agent @mention routing.
  // This overwrites the agent-runtime's initial registration (same composite key agentId:skillId).
  // SKILL_HOST_PORT is the host-mapped port; fall back to SERVICE_PORT for local dev.
  const skillHostPort = process.env.SKILL_HOST_PORT ?? String(SERVICE_PORT);
  await fetch(`${KERNEL_URL}/api/services/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skillId: "telegram",
      type: "channel",
      agentId: AGENT_ID,
      capabilities: ["send_message", "receive_message"],
      endpoint: `http://localhost:${skillHostPort}`,
      metadata: { botUsername: bot.botInfo.username },
    }),
  }).then(() => console.log(`[telegram] Registered bot @${bot.botInfo.username} with Kernel`))
    .catch((err: unknown) => console.error("[telegram] Failed to register bot username:", err));

  // Register command menu with Telegram (visible in input field autocomplete)
  await bot.api.setMyCommands([
    { command: "status", description: "Kernel status, uptime, queue" },
    { command: "help", description: "Show available commands" },
    { command: "models", description: "Choose model (inline keyboard)" },
    { command: "model", description: "Switch model by name" },
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

  // --- Cross-agent @mention routing ---

  /** Cache: botUsername → agentId. Refreshed periodically from Kernel. */
  const botRegistry = new Map<string, string>();

  async function refreshBotRegistry(): Promise<void> {
    try {
      const res = await fetch(`${KERNEL_URL}/api/status`);
      const data = await res.json() as {
        services: Record<string, { agentId?: string; skillId: string; metadata?: { botUsername?: string } }>;
      };
      botRegistry.clear();
      for (const svc of Object.values(data.services)) {
        if (svc.skillId === "telegram" && svc.metadata?.botUsername && svc.agentId) {
          botRegistry.set(svc.metadata.botUsername, svc.agentId);
        }
      }
    } catch { /* ignore — Kernel may be temporarily unavailable */ }
  }

  // Initial load + periodic refresh
  await refreshBotRegistry();
  setInterval(refreshBotRegistry, 60_000);

  /** Broadcast outbound message to all other agents' skills via /inject.
   * Target skill feeds it through Grammy handler — existing logic decides
   * whether to just persist (JSONL) or also activate the agent. */
  function broadcastToOtherAgents(chatId: string, text: string, sentMsgId: number): void {
    const seen = new Set<string>();
    for (const [, agentId] of botRegistry) {
      if (agentId === AGENT_ID || seen.has(agentId)) continue;
      seen.add(agentId);
      fetch(`${KERNEL_URL}/api/messages/outbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "telegram",
          agentId,
          conversation: chatId,
          content: { type: "text", text: "" },
          skillEndpoint: "/inject",
          payload: {
            sender: { id: String(bot.botInfo.id), name: bot.botInfo.first_name },
            text,
            tgMsgId: sentMsgId,
            timestamp: Date.now(),
          },
        }),
      }).catch((err) => console.error(`[telegram] Failed to broadcast to ${agentId}:`, err));
    }
    if (seen.size > 0) {
      console.log(`[telegram] Broadcast to ${seen.size} other agent(s) (tgMsgId:${sentMsgId})`);
    }
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

  // --- Inbound message buffering (debounce, media group, text fragment) ---

  interface BufferedTextEntry {
    text: string;
    chatId: string;
    tgMsgId: number;
    seq: number;
    timestamp: number;
    sender: { id: string; name: string; channel: string };
    conversation: { id: string; type: "dm" | "group"; title?: string };
    replyContent?: ReplyContent;
    mentioned?: boolean;
  }

  const DEBOUNCE_MS = 300;
  const MEDIA_GROUP_MS = 500;
  const FRAGMENT_GAP_MS = 1500;
  const FRAGMENT_THRESHOLD = 4000;
  const FRAGMENT_MAX_PARTS = 12;

  // Text debounce: merge consecutive text messages from same sender in same chat
  const textDebounceBuffers = new Map<string, { entries: BufferedTextEntry[]; timer: ReturnType<typeof setTimeout> }>();

  function debounceText(entry: BufferedTextEntry, onFlush: (merged: BufferedTextEntry) => void): void {
    const key = `${entry.chatId}:${entry.sender.id}`;
    const existing = textDebounceBuffers.get(key);
    if (existing) {
      existing.entries.push(entry);
      clearTimeout(existing.timer);
    } else {
      textDebounceBuffers.set(key, { entries: [entry], timer: null as any });
    }
    const buf = textDebounceBuffers.get(key)!;
    buf.timer = setTimeout(() => {
      textDebounceBuffers.delete(key);
      const entries = buf.entries;
      const last = entries[entries.length - 1];
      onFlush({
        ...last,
        text: entries.map(e => e.text).join("\n"),
        replyContent: entries[0].replyContent,
        mentioned: entries.some(e => e.mentioned === true) ? true : last.mentioned,
      });
    }, DEBOUNCE_MS);
  }

  // Media group: merge multi-photo messages sharing media_group_id
  interface MediaGroupEntry {
    chatId: string;
    tgMsgId: number;
    seq: number;
    timestamp: number;
    sender: { id: string; name: string; channel: string };
    conversation: { id: string; type: "dm" | "group"; title?: string };
    replyContent?: ReplyContent;
    mentioned?: boolean;
    caption: string;
    imageData: string; // base64
    imageMimeType: string;
  }

  const mediaGroupBuffers = new Map<string, { entries: MediaGroupEntry[]; timer: ReturnType<typeof setTimeout> }>();

  function bufferMediaGroup(
    groupId: string,
    entry: MediaGroupEntry,
    onFlush: (entries: MediaGroupEntry[]) => void,
  ): void {
    const existing = mediaGroupBuffers.get(groupId);
    if (existing) {
      existing.entries.push(entry);
      clearTimeout(existing.timer);
    } else {
      mediaGroupBuffers.set(groupId, { entries: [entry], timer: null as any });
    }
    const buf = mediaGroupBuffers.get(groupId)!;
    buf.timer = setTimeout(() => {
      mediaGroupBuffers.delete(groupId);
      onFlush(buf.entries);
    }, MEDIA_GROUP_MS);
  }

  // Text fragment: reassemble long pastes split by Telegram (>4096 chars)
  const fragmentBuffers = new Map<string, {
    entries: BufferedTextEntry[];
    lastMsgId: number;
    lastTs: number;
    timer: ReturnType<typeof setTimeout>;
  }>();

  function bufferFragment(
    entry: BufferedTextEntry,
    onFlush: (merged: BufferedTextEntry) => void,
  ): boolean {
    const key = `${entry.chatId}:${entry.sender.id}:fragment`;
    const existing = fragmentBuffers.get(key);

    // Check if this continues an existing fragment
    if (existing) {
      const gap = entry.timestamp - existing.lastTs;
      const consecutive = entry.tgMsgId === existing.lastMsgId + 1;
      if (consecutive && gap < FRAGMENT_GAP_MS && existing.entries.length < FRAGMENT_MAX_PARTS) {
        existing.entries.push(entry);
        existing.lastMsgId = entry.tgMsgId;
        existing.lastTs = entry.timestamp;
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => flushFragment(key, onFlush), FRAGMENT_GAP_MS);
        return true; // consumed
      }
      // Not a continuation — flush previous, don't consume current
      clearTimeout(existing.timer);
      flushFragment(key, onFlush);
    }

    // Start new fragment buffer if this message is long enough
    if (entry.text.length >= FRAGMENT_THRESHOLD) {
      fragmentBuffers.set(key, {
        entries: [entry],
        lastMsgId: entry.tgMsgId,
        lastTs: entry.timestamp,
        timer: setTimeout(() => flushFragment(key, onFlush), FRAGMENT_GAP_MS),
      });
      return true; // consumed
    }

    return false; // not consumed, handle normally
  }

  function flushFragment(key: string, onFlush: (merged: BufferedTextEntry) => void): void {
    const buf = fragmentBuffers.get(key);
    if (!buf) return;
    fragmentBuffers.delete(key);
    const entries = buf.entries;
    const last = entries[entries.length - 1];
    onFlush({
      ...last,
      text: entries.map(e => e.text).join(""),
      replyContent: entries[0].replyContent,
      mentioned: entries.some(e => e.mentioned === true) ? true : last.mentioned,
    });
  }

  /** Resolve reply-to message content for inline embedding in notification. */
  async function resolveReplyContent(
    chatId: string,
    replyMsg: any,
  ): Promise<ReplyContent> {
    const ref = ensureReplyPersisted(chatId, replyMsg);

    if (replyMsg.text) {
      const text = replyMsg.text as string;
      if (text.length <= PREVIEW_LIMIT) {
        return { ref, preview: text };
      }
      return { ref, preview: `${safeSlice(text, PREVIEW_LIMIT)}... (${text.length}字)` };
    }

    if (replyMsg.photo) {
      const largest = replyMsg.photo[replyMsg.photo.length - 1];
      const captionNote = replyMsg.caption ? `: ${safeSlice(replyMsg.caption, 100)}` : "";
      try {
        const { buf } = await downloadTelegramFile(largest.file_id);
        const mimeType = detectImageType(buf);
        return {
          ref,
          preview: `[图片${captionNote}]`,
          image: { data: buf.toString("base64"), mimeType },
        };
      } catch {
        return { ref, preview: `[图片${captionNote}]` };
      }
    }

    if (replyMsg.sticker) {
      const s = replyMsg.sticker;
      const isStatic = !s.is_animated && !s.is_video;
      const emojiLabel = s.emoji ? ` ${s.emoji}` : "";
      if (isStatic) {
        try {
          const { buf } = await downloadTelegramFile(s.file_id);
          return {
            ref,
            preview: `[贴纸${emojiLabel}]`,
            image: { data: buf.toString("base64"), mimeType: "image/webp" },
          };
        } catch { /* fall through */ }
      }
      return { ref, preview: `[贴纸${emojiLabel}]` };
    }

    if (replyMsg.document) {
      const filename = replyMsg.document.file_name ?? "unknown";
      const captionNote = replyMsg.caption ? `, "${safeSlice(replyMsg.caption, 100)}"` : "";
      return { ref, preview: `[文件: ${filename}${captionNote}]` };
    }

    if (replyMsg.voice || replyMsg.audio) {
      const duration = (replyMsg.voice ?? replyMsg.audio)?.duration;
      const durStr = duration ? `, ${duration}秒` : "";
      return { ref, preview: `[语音${durStr}]` };
    }

    return { ref, preview: "[消息]" };
  }

  const chatActionBreaker = new ChatActionCircuitBreaker();

  // --- Skill-level slash command handler ---

  // --- ACK reaction tracking ---
  // Track the latest message we ACK'd per chat, so we can remove it when replying.
  const pendingAcks = new Map<string, number>(); // chatId → tgMsgId

  async function setAck(chatId: string, tgMsgId: number): Promise<void> {
    try {
      await bot.api.setMessageReaction(chatId, tgMsgId, [{ type: "emoji", emoji: "👀" } as any]);
      pendingAcks.set(chatId, tgMsgId);
    } catch { /* some chats don't support reactions */ }
  }

  async function clearAck(chatId: string): Promise<void> {
    const msgId = pendingAcks.get(chatId);
    if (!msgId) return;
    pendingAcks.delete(chatId);
    try {
      await bot.api.setMessageReaction(chatId, msgId, []);
    } catch { /* ignore */ }
  }

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

      } else if (cmd === "/models") {
        const keyboard = new InlineKeyboard();
        for (const m of MODEL_OPTIONS) {
          keyboard.text(m.label, `models:${m.id}`).row();
        }
        await bot.api.sendMessage(chatId, "选择模型：", {
          reply_parameters: { message_id: replyToMsgId },
          reply_markup: keyboard,
        });

      } else if (cmd === "/help") {
        const helpText = [
          "Skill commands (instant):",
          "  /status — Kernel status, uptime, queue",
          "  /models — Choose model (inline keyboard)",
          "  /help — This message",
          "",
          "Agent commands (routed to runtime):",
          "  /model <name> — Switch model by name",
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
    if (!ctx.from || (!ctx.from.is_bot && !isUserAllowed(ctx.from.id))) return;

    const msg = ctx.message;
    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type !== "private";
    const sender = makeSender(ctx.from);
    const conversation = makeConversation(ctx.chat);
    const tgMsgId = msg.message_id;
    const timestamp = msg.date * 1000;

    // --- Handle reply-to: resolve content for inline embedding ---
    let replyContent: ReplyContent | undefined;
    if (msg.reply_to_message) {
      replyContent = await resolveReplyContent(chatId, msg.reply_to_message as any);
    }
    const mentioned = isGroup ? isDirectlyAddressed(ctx) : undefined;
    const headerOpts = { reply: replyContent, mentioned };

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
          if (cmd === "/start" || cmd === "/status" || cmd === "/help" || cmd === "/models") {
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

        // --- Normal text message handling (debounced + fragment-aware) ---
        // JSONL write is deferred to flush callback so merged text gets a single record.

        // Group check: skip debounce path for messages that won't be forwarded
        if (isGroup && !isDirectlyAddressed(ctx) && !isWatched(chatId)) {
          appendToLog(chatId, { ...logBase, type: "text", text: msg.text });
          return;
        }
        if (isGroup && isDirectlyAddressed(ctx)) {
          watchMap.set(chatId, Date.now() + DEFAULT_WATCH_MINUTES * 60_000);
        }

        const entry: BufferedTextEntry = {
          text, chatId, tgMsgId, seq: -1, timestamp,
          sender, conversation,
          replyContent, mentioned,
        };

        const flushTextEntry = (merged: BufferedTextEntry) => {
          // Write merged text as a single JSONL record
          const mergedSeq = appendToLog(merged.chatId, { ...logBase, type: "text", text: merged.text });
          const hOpts = { reply: merged.replyContent, mentioned: merged.mentioned };
          const header = buildNotificationHeader(merged.chatId, merged.sender.name, mergedSeq, merged.tgMsgId, hOpts);
          let content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string; caption: string };
          if (merged.text.length <= PREVIEW_LIMIT) {
            content = { type: "text", text: `${header}\n${merged.text}` };
          } else {
            content = { type: "text", text: `${header}\n${safeSlice(merged.text, 100)}...\n  (full text in JSONL)` };
          }
          // Inline reply image upgrade
          if (merged.replyContent?.image && content.type === "text") {
            content = { type: "image", data: merged.replyContent.image.data, mimeType: merged.replyContent.image.mimeType, caption: content.text };
          }
          void doForwardToKernel(merged.chatId, merged.tgMsgId, merged.sender, merged.conversation, content, merged.timestamp);
        };

        // Try text fragment buffer first (long paste reassembly)
        if (!bufferFragment(entry, flushTextEntry)) {
          // Not a fragment — go through debounce
          debounceText(entry, flushTextEntry);
        }
        return; // handled by debounce/fragment flush callback

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

          // Media group: buffer multiple photos sent together
          const mediaGroupId = (msg as any).media_group_id as string | undefined;
          if (mediaGroupId) {
            const mgEntry: MediaGroupEntry = {
              chatId, tgMsgId, seq, timestamp, sender, conversation,
              replyContent, mentioned,
              caption, imageData: buf.toString("base64"), imageMimeType: mimeType,
            };
            bufferMediaGroup(mediaGroupId, mgEntry, (entries) => {
              // Flush: send first image as image content, note total count in caption
              if (isGroup && !entries.some(e => e.mentioned === true) && !isWatched(chatId)) return;
              const first = entries[0];
              const last = entries[entries.length - 1];
              const hOpts = { reply: first.replyContent, mentioned: entries.some(e => e.mentioned === true) ? true : first.mentioned };
              const header = buildNotificationHeader(last.chatId, last.sender.name, last.seq, last.tgMsgId, hOpts);
              const countNote = entries.length > 1 ? `\n[${entries.length}张图片]` : "";
              const captionNote = first.caption ? `\n${first.caption}` : "";
              const content: { type: "image"; data: string; mimeType: string; caption: string } = {
                type: "image", data: first.imageData, mimeType: first.imageMimeType,
                caption: `${header}${countNote}${captionNote}`,
              };
              void doForwardToKernel(last.chatId, last.tgMsgId, last.sender, last.conversation, content, last.timestamp);
            });
            return; // handled by media group flush
          }

          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, headerOpts);
          kernelContent = { type: "image", data: buf.toString("base64"), mimeType, caption: `${header}${caption ? `\n${caption}` : ""}` };
        } catch (err) {
          console.error("[telegram] Failed to download photo:", err);
          seq = appendToLog(chatId, { ...logBase, type: "image", fileId: largest.file_id, caption: caption || null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, headerOpts);
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
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, headerOpts);

          if (isStatic) {
            kernelContent = { type: "image", data: buf.toString("base64"), mimeType: "image/webp", caption: `${header}\n[贴纸${emojiLabel}]` };
          } else {
            kernelContent = { type: "text", text: `${header}\n[贴纸${emojiLabel}${setLabel}]` };
          }
        } catch {
          seq = appendToLog(chatId, { ...logBase, type: "sticker", fileId: sticker.file_id, emoji: sticker.emoji ?? null, setName: sticker.set_name ?? null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, headerOpts);
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
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, headerOpts);
          kernelContent = { type: "text", text: `${header}\n[文件: ${fileName}, ${formatSize(buf.length)}${caption ? `, "${caption}"` : ""}]` };
        } catch {
          seq = appendToLog(chatId, { ...logBase, type: "file", filename: fileName, mimeType: doc.mime_type ?? null, caption: caption || null });
          const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, headerOpts);
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
        const header = buildNotificationHeader(chatId, sender.name, seq!, tgMsgId, headerOpts);
        kernelContent = { type: "text", text: `${header}\n[语音消息${durStr}]` };

      } else {
        seq = appendToLog(chatId, { ...logBase, type: "other" });
        const header = buildNotificationHeader(chatId, sender.name, seq, tgMsgId, headerOpts);
        kernelContent = { type: "text", text: `${header}\n[不支持的消息类型]` };
      }
    } catch (err) {
      console.error("[telegram] Failed to process message:", err);
      return;
    }

    // --- Inline reply image: upgrade text content to image if reply provides one ---
    if (replyContent?.image && kernelContent?.type === "text") {
      kernelContent = {
        type: "image",
        data: replyContent.image.data,
        mimeType: replyContent.image.mimeType,
        caption: kernelContent.text,
      };
    }

    // --- Group: only forward if directly addressed or watched ---
    if (isGroup && !isDirectlyAddressed(ctx) && !isWatched(chatId)) return;

    // Auto-start watch window when directly addressed in group
    if (isGroup && isDirectlyAddressed(ctx)) {
      watchMap.set(chatId, Date.now() + DEFAULT_WATCH_MINUTES * 60_000);
    }
    if (!kernelContent) return;

    // --- Forward to Kernel (direct or deferred via debounce) ---
    await doForwardToKernel(chatId, tgMsgId, sender, conversation, kernelContent, timestamp);
  });

  /** Common forwarding path used by both direct handler and debounce flush. */
  async function doForwardToKernel(
    chatId: string,
    tgMsgId: number,
    sender: { id: string; name: string; channel: string },
    conversation: { id: string; type: "dm" | "group"; title?: string },
    content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string; caption: string },
    timestamp: number,
  ): Promise<void> {
    try {
      await forwardToKernel({
        id: `tg_${chatId}_${tgMsgId}`,
        channel: "telegram",
        agentId: AGENT_ID,
        sender,
        conversation,
        content,
        timestamp,
      });
      console.log(`[telegram] Forwarded ${content.type} from ${sender.name} (tgMsgId:${tgMsgId})`);
      void setAck(chatId, tgMsgId);
    } catch (err) {
      console.error("[telegram] Failed to forward to kernel:", err);
    }
  }

  // --- Inline keyboard callback handler (model selection) ---

  bot.callbackQuery(/^models:(.+)$/, async (ctx) => {
    if (!ctx.callbackQuery.message) {
      await ctx.answerCallbackQuery({ text: "Message expired" });
      return;
    }
    const modelId = ctx.match![1];
    const label = MODEL_OPTIONS.find(m => m.id === modelId)?.label ?? modelId;
    const chatId = String(ctx.callbackQuery.message.chat.id);
    const msgId = ctx.callbackQuery.message.message_id;

    await ctx.answerCallbackQuery({ text: `已选择 ${label}` });
    await bot.api.editMessageText(chatId, msgId, `模型已切换：${label}`, {
      reply_markup: { inline_keyboard: [] },
    });

    // Forward as /model command to Agent via Kernel
    const fromUser = ctx.callbackQuery.from;
    await forwardToKernel({
      id: `tg_${chatId}_models_${Date.now()}`,
      channel: "telegram",
      agentId: AGENT_ID,
      sender: makeSender(fromUser),
      conversation: makeConversation(ctx.callbackQuery.message!.chat as any),
      content: { type: "text", text: `/model ${modelId}` },
      timestamp: Date.now(),
      metadata: { command: "/model", args: modelId, raw: `/model ${modelId}` },
    });
    console.log(`[telegram] Model switched to ${label} (${modelId}) by ${fromUser.first_name}`);
  });

  // Catch-all for unhandled callback queries (prevent loading animation hang)
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
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
        const { conversation, content, replyTo, editMessageId, progress } = body as {
          conversation: string;
          content: { type: string; text?: string; data?: string; mimeType?: string; caption?: string; filename?: string };
          replyTo?: string;
          editMessageId?: string;
          progress?: boolean;
        };

        // Edit path: editMessageId present
        if (editMessageId) {
          if (content.type !== "text") {
            sendJson(res, 400, { error: "editMessageId is only supported for text content" });
            return;
          }
          const msgId = parseInt(editMessageId, 10);
          if (isNaN(msgId)) {
            sendJson(res, 400, { error: "Invalid editMessageId" });
            return;
          }
          await bot.api.editMessageText(conversation, msgId, content.text!);
          sendJson(res, 200, { success: true });
          return;
        }

        // Clear ACK reaction before sending actual reply (not progress updates)
        if (!progress) void clearAck(conversation);

        // Send path
        if (content.type === "text") {
          // Parse replyTo: handles both raw IDs and composite "tg-chatId-msgId" format
          let replyMsgId: number | undefined;
          if (replyTo) {
            const idPart = replyTo.startsWith("tg_") ? replyTo.split("_").pop() : replyTo;
            const parsed = idPart ? parseInt(idPart, 10) : NaN;
            if (!isNaN(parsed)) replyMsgId = parsed;
          }

          const text = content.text!;
          const sent = await bot.api.sendMessage(conversation, text, {
            ...(replyMsgId ? { reply_parameters: { message_id: replyMsgId } } : {}),
          });

          // Skip JSONL for progress messages (ephemeral)
          if (!progress) {
            const outSeq = appendToLog(conversation, {
              ts: Date.now(),
              tgMsgId: sent.message_id,
              sender: { id: "bot", name: "Agent" },
              type: "text",
              text,
              ...(replyMsgId ? { replyToTgMsgId: replyMsgId } : {}),
            });
            broadcastToOtherAgents(conversation, text, sent.message_id);
            sendJson(res, 200, { success: true, messageId: sent.message_id, seq: outSeq });
          } else {
            sendJson(res, 200, { success: true, messageId: sent.message_id });
          }

          return;
        }

        if (content.type === "image") {
          const { mimeType, caption } = content;
          const buf = Buffer.from(content.data!, "base64");
          const ext = mimeType?.split("/")[1] ?? "jpg";
          const inputFile = new InputFile(buf, `image.${ext}`);
          const sent = await bot.api.sendPhoto(conversation, inputFile, {
            ...(caption ? { caption } : {}),
          });
          const outSeq = appendToLog(conversation, {
            ts: Date.now(),
            tgMsgId: sent.message_id,
            sender: { id: "bot", name: "Agent" },
            type: "image",
            caption: caption ?? "",
          });
          sendJson(res, 200, { success: true, messageId: sent.message_id, seq: outSeq });
          return;
        }

        if (content.type === "file") {
          const { filename, mimeType, caption } = content;
          const buf = Buffer.from(content.data!, "base64");
          const inputFile = new InputFile(buf, filename ?? "file");
          const sent = await bot.api.sendDocument(conversation, inputFile, {
            ...(caption ? { caption } : {}),
          });
          const outSeq = appendToLog(conversation, {
            ts: Date.now(),
            tgMsgId: sent.message_id,
            sender: { id: "bot", name: "Agent" },
            type: "file",
            filename: filename ?? "file",
            caption: caption ?? "",
          });
          sendJson(res, 200, { success: true, messageId: sent.message_id, seq: outSeq });
          return;
        }

        sendJson(res, 400, { error: `Unsupported content type: ${content.type}` });
      } catch (err) {
        console.error("[telegram] Failed to send outbound message:", err);
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
        const { conversation, date, seq, messageId, before, after, attachments: wantAttachments } = body as {
          conversation: string; date: string; seq?: number; messageId?: number;
          before?: number; after?: number; attachments?: boolean;
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

        const isRange = (before != null && before > 0) || (after != null && after > 0);
        const hasAnchor = seq != null || messageId != null;

        // --- Recent mode: no anchor, return tail ---
        if (!hasAnchor) {
          const count = Math.min(before ?? 20, 200);
          const startIdx = Math.max(0, lines.length - count);
          const records = lines.slice(startIdx).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          sendJson(res, 200, { success: true, messages: records, total: lines.length });
          return;
        }

        // --- Find anchor record ---
        let anchorIdx = -1;
        if (seq != null && seq >= 0 && seq < lines.length) {
          try { const p = JSON.parse(lines[seq]); if (p.seq === seq) anchorIdx = seq; } catch { /* fallthrough */ }
        }
        if (anchorIdx < 0) {
          for (let i = 0; i < lines.length; i++) {
            const parsed = JSON.parse(lines[i]);
            if (seq != null && parsed.seq === seq) { anchorIdx = i; break; }
            if (messageId != null && parsed.tgMsgId === messageId) { anchorIdx = i; break; }
          }
        }

        if (anchorIdx < 0) {
          sendJson(res, 404, { error: "Message not found" });
          return;
        }

        // --- Single message (backward compat) ---
        if (!isRange) {
          const record = JSON.parse(lines[anchorIdx]) as Record<string, unknown>;
          const attachmentsList: { mimeType: string; data: string }[] = [];
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
              attachmentsList.push({ mimeType: mimeMap[ext] ?? "application/octet-stream", data: buf.toString("base64") });
            }
          }
          sendJson(res, 200, { success: true, message: record, attachments: attachmentsList });
          return;
        }

        // --- Range mode: anchor ± before/after ---
        const bCount = Math.min(before ?? 0, 200);
        const aCount = Math.min(after ?? 0, 200);
        const startIdx = Math.max(0, anchorIdx - bCount);
        const endIdx = Math.min(lines.length - 1, anchorIdx + aCount);
        const records = [];
        for (let i = startIdx; i <= endIdx; i++) {
          try { records.push(JSON.parse(lines[i])); } catch { /* skip */ }
        }

        // Optionally include attachments for each record
        if (wantAttachments) {
          const mimeMap: Record<string, string> = {
            jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
            webp: "image/webp", gif: "image/gif", ogg: "audio/ogg",
            mp3: "audio/mpeg", webm: "video/webm",
          };
          for (const rec of records) {
            if (rec.path && typeof rec.path === "string" && !rec.path.includes("..")) {
              const absPath = join(DATA_BASE, date, rec.path);
              if (existsSync(absPath)) {
                const buf = readFileSync(absPath);
                const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
                rec._attachment = { mimeType: mimeMap[ext] ?? "application/octet-stream", data: buf.toString("base64") };
              }
            }
          }
        }

        const anchorSeq = records[anchorIdx - startIdx]?.seq ?? anchorIdx;
        sendJson(res, 200, { success: true, messages: records, anchorSeq, total: lines.length });
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

    } else if (req.method === "POST" && req.url === "/inject") {
      // Cross-agent injection: construct synthetic Telegram Update and feed through
      // Grammy handler. Existing bot.on("message") handles JSONL persistence,
      // @mention/watch detection, and conditional Kernel forwarding — zero duplicated logic.
      try {
        const body = await parseBody(req);
        const { conversation, sender, text, tgMsgId, timestamp } = body as {
          conversation: string;
          sender: { id: string; name: string };
          text: string;
          tgMsgId: number;
          timestamp: number;
        };

        await bot.handleUpdate({
          update_id: 0,
          message: {
            message_id: tgMsgId,
            from: { id: Number(sender.id), is_bot: true, first_name: sender.name },
            chat: { id: Number(conversation), type: "group" },
            date: Math.floor(timestamp / 1000),
            text,
          },
        } as any);

        console.log(`[telegram] Injected message from ${sender.name} (tgMsgId:${tgMsgId})`);
        sendJson(res, 200, { success: true });
      } catch (err) {
        console.error("[telegram] Failed to inject message:", err);
        sendJson(res, 500, { error: String(err) });
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
