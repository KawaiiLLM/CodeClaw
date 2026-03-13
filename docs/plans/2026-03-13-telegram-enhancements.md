# Telegram Enhancements Implementation Plan (v3)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign Telegram Skill message handling (JSONL with seq IDs, remove RingBuffer), add rich Agent tools (react/edit/delete/sticker/poll), harden with 401 circuit breaker.

**Architecture:**
- **Skill 负责格式化通知文本** — 所有元数据（seq、date、jsonlPath、reply-to）由 Skill 嵌入 content，Agent Runtime 不感知 Telegram 特有字段
- **图片内联 base64** — Skill 下载一次，存 JSONL + base64 直接嵌入 Kernel payload
- **文件/音频用文字占位符** — Skill 转成 `[文件: xxx, 1.2KB]` 形式的文本
- **引用消息只传唯一标识** — Skill 确保引用消息已持久化，Agent 自行按需查询
- **Agent Runtime 纯透传** — `formatMessageForAgent` 只做 `MessageContent → SDK 格式` 转换，不解析任何 Skill 特有字段
- **出站按语义分流** — 产生用户可见内容的操作（send_message/edit/sticker/poll）走 Kernel 路由；查询和轻量操作（react/delete/get_sticker_set/get_message）直连 Skill
- **Telegram 细节在 SKILL.md** — JSONL 路径、seq 格式、reply-to 引用格式等 Telegram 专属知识在 `skills/telegram/SKILL.md`，不在 SDK_SYSTEM_APPEND 或共享类型中

**Tech Stack:** Grammy 1.35+ (Bot API 7.0), Claude Agent SDK, TypeScript ESM

---

### Task 1: Extend Types + Kernel Body Limit + Outbound Routing

**Files:**
- Modify: `packages/types/src/messages.ts`
- Modify: `packages/kernel/src/http-server.ts`
- Modify: `packages/kernel/src/io-bridge.ts`
- Modify: `packages/agent-runtime/src/kernel-client.ts`

InboundMessage 不加 Telegram 特有字段（保持通用）。扩展 image 支持内联 base64。扩展 OutboundMessage 支持自定义 Skill 端点路由（`send_sticker`、`send_poll` 等出站消息走 Kernel）。

**Step 1: Add `data` and `mimeType` to image MessageContent**

```typescript
export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; data?: string; mimeType?: string; path?: string; caption?: string }
  | { type: "audio"; url?: string; path?: string; duration?: number }
  | { type: "file"; filename: string; path?: string; size?: number; url?: string; mimeType?: string };
```

**Step 2: Add `skillEndpoint` and `payload` to OutboundMessage**

```typescript
export interface OutboundMessage {
  channel: string;
  conversation: string;
  content: MessageContent;
  replyTo?: string;
  editMessageId?: string;
  progress?: boolean;
  /** Custom Skill endpoint for non-message outbound operations (e.g. "/sticker", "/poll"). */
  skillEndpoint?: string;
  /** Endpoint-specific payload. Sent to Skill when skillEndpoint is set. */
  payload?: Record<string, unknown>;
}
```

InboundMessage 保持不变。

**Step 3: Extend Kernel I/O Bridge routing**

In `packages/kernel/src/io-bridge.ts`, update `routeOutbound()`:

```typescript
async routeOutbound(msg: OutboundMessage): Promise<Record<string, unknown>> {
  const service = this.getServiceForChannel(msg.channel);
  if (!service) {
    throw new Error(`No skill service registered for channel: ${msg.channel}`);
  }

  // Custom Skill endpoint: transparent pass-through
  if (msg.skillEndpoint) {
    const url = `${service.endpoint}${msg.skillEndpoint}`;
    logger.debug({ channel: msg.channel, conversation: msg.conversation, endpoint: url }, "Routing to custom skill endpoint");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation: msg.conversation, ...msg.payload }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Skill service ${service.skillId} returned ${res.status}: ${body}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  // Standard message routing: /edit or /send
  const route = msg.editMessageId ? "/edit" : "/send";
  // ... (rest unchanged)
}
```

**Step 4: Add `sendOutbound` to KernelClient**

In `packages/agent-runtime/src/kernel-client.ts`, add a method for custom endpoint routing:

```typescript
async sendOutbound(msg: { channel: string; conversation: string; skillEndpoint: string; payload: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const res = await this.post("/api/messages/outbound", {
    channel: msg.channel,
    conversation: msg.conversation,
    content: { type: "text", text: "" }, // not used for custom endpoints
    skillEndpoint: msg.skillEndpoint,
    payload: msg.payload,
  });
  return res;
}
```

**Step 5: Increase Kernel body limit**

In `packages/kernel/src/http-server.ts`, change:
```typescript
const MAX_BODY_BYTES = 10_485_760; // 10MB (base64 images can be large)
```

**Step 6: Commit**

```bash
git add packages/types/src/messages.ts packages/kernel/src/http-server.ts packages/kernel/src/io-bridge.ts packages/agent-runtime/src/kernel-client.ts
git commit -m "feat: MessageContent inline base64, OutboundMessage skillEndpoint routing, kernel body limit"
```

---

### Task 2: JSONL Storage Refactor + Message Handler Rewrite

**Files:**
- Modify: `skills/telegram/service.ts`

核心变更：Skill 负责 JSONL 持久化（date 目录、seq ID）、通知文本格式化、引用消息持久化。发给 Kernel 的 `InboundMessage` 只包含通用字段，所有元数据嵌入 `content` 文本。

**Step 1: Replace DATA_DIR, add seq tracking + date-based helpers + notification formatting**

Replace `DATA_DIR` constant (line 25) and JSONL helpers (lines 70-91) with:

```typescript
const DATA_BASE = `${HOME}/.claude/data/telegram`;
const PREVIEW_LIMIT = 200;

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

function nextSeq(chatId: string): number {
  const today = todayStr();
  const entry = seqCounters.get(chatId);
  if (entry && entry.date === today) {
    return ++entry.seq;
  }
  const path = getJsonlPath(chatId, today);
  let startSeq = 0;
  if (existsSync(path)) {
    const content = readFileSync(path, "utf-8").trimEnd();
    if (content) {
      const lastLine = content.split("\n").pop()!;
      try { startSeq = JSON.parse(lastLine).seq + 1; }
      catch { startSeq = content.split("\n").length; }
    }
  }
  seqCounters.set(chatId, { date: today, seq: startSeq });
  return startSeq;
}

function appendToLog(chatId: string, record: Record<string, unknown>): number {
  const seq = nextSeq(chatId);
  const path = getJsonlPath(chatId);
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
  replyRef?: string,
): string {
  const date = todayStr();
  const replyTag = replyRef ? ` reply-to:${replyRef}` : "";
  return `[telegram/${chatId}] ${senderName} (${date} seq:${seq}${replyTag}):\n  -> ~/.claude/data/telegram/${date}/${chatId}.jsonl`;
}
```

**Step 2: Add `ensureReplyPersisted`**

When a message has `reply_to_message`, ensure the referenced message exists in today's JSONL. If not, persist its metadata (text, type, sender, fileId, etc. — no binary downloads).

```typescript
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
  const today = todayStr();

  // Check in-memory index (populated lazily from JSONL on first access)
  const knownIds = getPersistedSet(chatId, today);
  if (knownIds.has(tgMsgId)) return `${today}/${chatId}/tgMsgId:${tgMsgId}`;

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

  appendToLog(chatId, logRecord);
  knownIds.add(tgMsgId);
  return `${today}/${chatId}/tgMsgId:${tgMsgId}`;
}
```

**Step 3: Delete RingBuffer, Active Window, and dead helpers**

Delete:
- `getReplyContext()` (line ~130)
- `ACTIVE_WINDOW_MS`, `BUFFER_CAPACITY` constants (line ~162)
- `BufferedMessage` interface, `RingBuffer` class (line ~165-180)
- `GroupState` interface, `groupStates` Map, `getGroupState()` (line ~182-196)
- `formatTime()`, `buildContextPrefix()` (line ~198-207)

**Step 4: Rewrite the unified message handler**

Replace the `bot.on("message", ...)` handler. Skill now:
1. Persists all messages to JSONL with seq IDs
2. Ensures reply-to messages are persisted
3. Formats the notification text (header + content)
4. Forwards a standard `InboundMessage` to Kernel (no extra fields)

```typescript
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

      seq = appendToLog(chatId, { ...logBase, type: "text", text: msg.text });
      const header = buildNotificationHeader(chatId, sender.name, seq, replyRef);

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
        saveFile(chatId, `${tgMsgId}_photo.${ext}`, buf);
        seq = appendToLog(chatId, { ...logBase, type: "image", fileId: largest.file_id, caption: caption || null });
        const header = buildNotificationHeader(chatId, sender.name, seq, replyRef);
        kernelContent = { type: "image", data: buf.toString("base64"), mimeType, caption: `${header}${caption ? `\n${caption}` : ""}` };
      } catch (err) {
        console.error("[telegram] Failed to download photo:", err);
        seq = appendToLog(chatId, { ...logBase, type: "image", fileId: largest.file_id, caption: caption || null });
        const header = buildNotificationHeader(chatId, sender.name, seq, replyRef);
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
        saveFile(chatId, `${tgMsgId}_sticker.${ext}`, buf);
        seq = appendToLog(chatId, { ...logBase, type: "sticker", fileId: sticker.file_id, emoji: sticker.emoji ?? null, setName: sticker.set_name ?? null });
        const header = buildNotificationHeader(chatId, sender.name, seq, replyRef);

        if (isStatic) {
          kernelContent = { type: "image", data: buf.toString("base64"), mimeType: "image/webp", caption: `${header}\n[贴纸${emojiLabel}]` };
        } else {
          kernelContent = { type: "text", text: `${header}\n[贴纸${emojiLabel}${setLabel}]` };
        }
      } catch {
        seq = appendToLog(chatId, { ...logBase, type: "sticker", fileId: sticker.file_id, emoji: sticker.emoji ?? null, setName: sticker.set_name ?? null });
        const header = buildNotificationHeader(chatId, sender.name, seq, replyRef);
        kernelContent = { type: "text", text: `${header}\n[贴纸${emojiLabel}]` };
      }

    } else if (msg.document) {
      const doc = msg.document;
      const fileName = doc.file_name ?? "unknown";
      let caption = msg.caption ?? "";
      if (botUsername) caption = caption.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim();

      try {
        const { buf } = await downloadTelegramFile(doc.file_id);
        saveFile(chatId, `${tgMsgId}_${fileName}`, buf);
        seq = appendToLog(chatId, { ...logBase, type: "file", filename: fileName, size: buf.length, mimeType: doc.mime_type ?? null, caption: caption || null });
        const header = buildNotificationHeader(chatId, sender.name, seq, replyRef);
        kernelContent = { type: "text", text: `${header}\n[文件: ${fileName}, ${formatSize(buf.length)}${caption ? `, "${caption}"` : ""}]` };
      } catch {
        seq = appendToLog(chatId, { ...logBase, type: "file", filename: fileName, mimeType: doc.mime_type ?? null, caption: caption || null });
        const header = buildNotificationHeader(chatId, sender.name, seq, replyRef);
        kernelContent = { type: "text", text: `${header}\n[文件: ${fileName}${caption ? `, "${caption}"` : ""}]` };
      }

    } else if (msg.voice || msg.audio) {
      const audio = msg.voice ?? msg.audio!;
      const durStr = audio.duration ? `, ${audio.duration}秒` : "";

      try {
        const { buf } = await downloadTelegramFile(audio.file_id);
        const ext = msg.voice ? "ogg" : "mp3";
        saveFile(chatId, `${tgMsgId}_audio.${ext}`, buf);
        seq = appendToLog(chatId, { ...logBase, type: "audio", duration: audio.duration ?? null });
      } catch {
        seq = appendToLog(chatId, { ...logBase, type: "audio", duration: audio.duration ?? null });
      }
      const header = buildNotificationHeader(chatId, sender.name, seq!, replyRef);
      kernelContent = { type: "text", text: `${header}\n[语音消息${durStr}]` };

    } else {
      seq = appendToLog(chatId, { ...logBase, type: "other" });
      const header = buildNotificationHeader(chatId, sender.name, seq, replyRef);
      kernelContent = { type: "text", text: `${header}\n[不支持的消息类型]` };
    }
  } catch (err) {
    console.error("[telegram] Failed to process message:", err);
    return;
  }

  // --- Group: only forward if directly addressed ---
  if (isGroup && !isDirectlyAddressed(ctx)) return;
  if (!kernelContent) return;

  // --- Forward standard InboundMessage to Kernel (no extra fields) ---
  try {
    await forwardToKernel({
      id: `tg_${chatId}_${tgMsgId}`,
      channel: "telegram",
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
```

**Step 5: Update /send handler to include seq in JSONL and response**

```typescript
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
```

**Step 6: Commit**

```bash
git add skills/telegram/service.ts
git commit -m "refactor: JSONL with date dirs + seq IDs, Skill-side notification formatting, remove RingBuffer"
```

---

### Task 3: 401 Circuit Breaker for sendChatAction

**Files:**
- Modify: `skills/telegram/service.ts`

**Step 1: Add ChatActionCircuitBreaker class**

Insert before `async function main()`:

```typescript
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
```

**Step 2: Wire into /action endpoint**

Create instance inside `main()`:
```typescript
const chatActionBreaker = new ChatActionCircuitBreaker();
```

Replace `/action` handler:
```typescript
} else if (req.method === "POST" && req.url === "/action") {
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
```

**Step 3: Commit**

```bash
git add skills/telegram/service.ts
git commit -m "feat: 401 circuit breaker for sendChatAction"
```

---

### Task 4: Telegram Skill New Endpoints

**Files:**
- Modify: `skills/telegram/service.ts`

Add 6 new HTTP endpoints. `/sticker_set` uses `s.thumbnail?.file_id` for efficiency. `/get_message` returns `attachments` array.

**Step 1: Add `/react` endpoint**

```typescript
} else if (req.method === "POST" && req.url === "/react") {
  try {
    const body = await parseBody(req);
    const { conversation, messageId, emoji, remove } = body as {
      conversation: string; messageId: number; emoji: string; remove?: boolean;
    };
    const reaction = remove || !emoji ? [] : [{ type: "emoji" as const, emoji }];
    await bot.api.setMessageReaction(conversation, messageId, reaction);
    sendJson(res, 200, { success: true });
  } catch (err) {
    console.error("[telegram] Failed to set reaction:", err);
    sendJson(res, 500, { error: String(err) });
  }
```

**Step 2: Add `/delete` endpoint**

```typescript
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
```

**Step 3: Add `/sticker` (send sticker) endpoint**

```typescript
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
```

**Step 4: Add `/sticker_set` endpoint (thumbnail optimization)**

Uses `s.thumbnail?.file_id` (small preview) instead of full sticker file.

```typescript
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

    const stickers = await Promise.all(page.map(async (s, i) => {
      const entry: Record<string, unknown> = {
        index: start + i,
        fileId: s.file_id,
        emoji: s.emoji ?? null,
        isAnimated: s.is_animated ?? false,
        isVideo: s.is_video ?? false,
      };
      if (!s.is_animated && !s.is_video) {
        const thumbFileId = s.thumbnail?.file_id ?? s.file_id;
        try {
          const { buf } = await downloadTelegramFile(thumbFileId);
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
```

**Step 5: Add `/poll` endpoint**

Note: check Grammy types for `sendPoll` — if Bot API 7.0 requires `InputPollOption[]`, map to `options.map(o => ({ text: o }))`.

```typescript
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
```

**Step 6: Add `/get_message` endpoint**

Reads JSONL by date + seq or platform message ID. Returns `attachments` array (base64 for any saved files).

```typescript
} else if (req.method === "POST" && req.url === "/get_message") {
  try {
    const body = await parseBody(req);
    const { conversation, date, seq, messageId } = body as {
      conversation: string; date: string; seq?: number; messageId?: number;
    };
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
```

**Step 7: Commit**

```bash
git add skills/telegram/service.ts
git commit -m "feat: /react /delete /sticker /sticker_set /poll /get_message endpoints"
```

---

### Task 5: MCP Tools in Agent Runtime

**Files:**
- Modify: `packages/agent-runtime/src/sdk-mcp-tools.ts`

Add 7 new MCP tools inside `createSdkMcpTools` function body (sharing closure variables).

**Routing split by semantics:**
- **Through Kernel** (outbound messages — auditable, rate-limitable): `send_sticker`, `send_poll` → `kernelClient.sendOutbound()` with `skillEndpoint`
- **Direct to Skill** (queries/lightweight ops — low latency): `react_message`, `delete_message`, `get_sticker_set`, `get_message` → `skillServiceManager.getEndpoint()` + fetch

Tools that produce user-visible content (`send_sticker`, `send_poll`) set `sentViaToolInTurn` and stop typing. `get_sticker_set` auto-triggers `choose_sticker` chat action.

**Step 1: Add `react_message` tool**

```typescript
const reactMessage = tool(
  "react_message",
  "Add or remove an emoji reaction on a message. Use to acknowledge messages, express emotions, or give quick feedback.",
  {
    channel: z.string().describe("Target channel (e.g. 'telegram')"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Message ID (numeric)"),
    emoji: z.string().describe("Emoji to react with. Must be supported by the target platform."),
    remove: z.boolean().optional().describe("If true, removes the reaction"),
  },
  async ({ channel, conversation, messageId, emoji, remove }) => {
    try {
      const endpoint = skillServiceManager.getEndpoint(channel);
      if (!endpoint) return { content: [{ type: "text" as const, text: `No skill for channel: ${channel}` }], isError: true };
      const res = await fetch(`${endpoint}/react`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation, messageId: Number(messageId), emoji, remove }),
      });
      if (!res.ok) return { content: [{ type: "text" as const, text: `Failed: ${await res.text()}` }], isError: true };
      return { content: [{ type: "text" as const, text: `Reaction ${remove ? "removed" : "added"}: ${emoji}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);
```

**Step 2: Add `edit_message` tool (through Kernel)**

```typescript
const editMessage = tool(
  "edit_message",
  "Edit a previously sent bot message.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Message ID to edit"),
    text: z.string().describe("New text content"),
  },
  async ({ channel, conversation, messageId, text }) => {
    try {
      await kernelClient.sendMessage({ channel, conversation, content: { type: "text", text }, editMessageId: messageId });
      return { content: [{ type: "text" as const, text: `Message ${messageId} edited` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);
```

**Step 3: Add `delete_message` tool**

```typescript
const deleteMessage = tool(
  "delete_message",
  "Delete a message. Can delete bot's own messages, or others in groups where bot is admin.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Message ID to delete"),
  },
  async ({ channel, conversation, messageId }) => {
    try {
      const endpoint = skillServiceManager.getEndpoint(channel);
      if (!endpoint) return { content: [{ type: "text" as const, text: `No skill for channel: ${channel}` }], isError: true };
      const res = await fetch(`${endpoint}/delete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation, messageId: Number(messageId) }),
      });
      if (!res.ok) return { content: [{ type: "text" as const, text: `Failed: ${await res.text()}` }], isError: true };
      return { content: [{ type: "text" as const, text: `Message ${messageId} deleted` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);
```

**Step 4: Add `send_sticker` tool**

```typescript
const sendSticker = tool(
  "send_sticker",
  "Send a sticker to a conversation. Use get_sticker_set first to browse available stickers.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    fileId: z.string().describe("Sticker file_id from get_sticker_set"),
    replyTo: z.string().optional().describe("Message ID to reply to"),
  },
  async ({ channel, conversation, fileId, replyTo }) => {
    try {
      sentViaToolInTurn = true;
      messageSentCallback?.();
      await kernelClient.sendOutbound({
        channel, conversation,
        skillEndpoint: "/sticker",
        payload: { conversation, fileId, replyTo: replyTo ? Number(replyTo) : undefined },
      });
      return { content: [{ type: "text" as const, text: "Sticker sent" }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);
```

**Step 5: Add `get_sticker_set` tool (with auto choose_sticker action)**

```typescript
const getStickerSet = tool(
  "get_sticker_set",
  "Browse a sticker set with visual thumbnails. Returns paginated stickers (default 10). Use to see what stickers look like before sending one.",
  {
    channel: z.string().describe("Target channel"),
    name: z.string().describe("Sticker set name (e.g. 'HotCherry')"),
    offset: z.number().optional().describe("Start index (default 0)"),
    limit: z.number().optional().describe("Number of stickers to return (default 10)"),
  },
  async ({ channel, name, offset, limit }) => {
    try {
      // Hook: auto-trigger choose_sticker action
      const conv = getConversation?.();
      if (conv) {
        const ep = skillServiceManager.getEndpoint(conv.channel);
        if (ep) {
          fetch(`${ep}/action`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversation: conv.conversationId, action: "choose_sticker" }),
          }).catch(() => {});
        }
      }

      const endpoint = skillServiceManager.getEndpoint(channel);
      if (!endpoint) return { content: [{ type: "text" as const, text: `No skill for channel: ${channel}` }], isError: true };

      const res = await fetch(`${endpoint}/sticker_set`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, offset, limit }),
      });
      if (!res.ok) return { content: [{ type: "text" as const, text: `Failed: ${await res.text()}` }], isError: true };

      const data = await res.json() as {
        name: string; title: string; total: number; offset: number; count: number;
        stickers: { index: number; fileId: string; emoji: string | null; thumbnail?: string; mimeType?: string; isAnimated: boolean; isVideo: boolean }[];
      };

      const blocks: any[] = [];
      blocks.push({ type: "text" as const, text: `${data.title} (${data.name}) — showing ${data.offset + 1}-${data.offset + data.count} of ${data.total}` });

      for (const s of data.stickers) {
        if (s.thumbnail && s.mimeType) {
          blocks.push({ type: "image" as const, data: s.thumbnail, mimeType: s.mimeType });
        }
        const label = `#${s.index} file_id=${s.fileId} emoji=${s.emoji ?? "none"}${s.isAnimated ? " [animated]" : ""}${s.isVideo ? " [video]" : ""}`;
        blocks.push({ type: "text" as const, text: label });
      }

      if (data.offset + data.count < data.total) {
        blocks.push({ type: "text" as const, text: `(${data.total - data.offset - data.count} more — use offset=${data.offset + data.count} to see next page)` });
      }

      return { content: blocks };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);
```

**Step 6: Add `send_poll` tool**

```typescript
const sendPoll = tool(
  "send_poll",
  "Create a poll in a conversation.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    question: z.string().describe("Poll question"),
    options: z.array(z.string()).describe("Poll options (2-10 items)"),
    isAnonymous: z.boolean().optional().describe("Anonymous voting (default true)"),
    allowsMultiple: z.boolean().optional().describe("Allow multiple answers (default false)"),
  },
  async ({ channel, conversation, question, options, isAnonymous, allowsMultiple }) => {
    try {
      sentViaToolInTurn = true;
      messageSentCallback?.();
      const res = await kernelClient.sendOutbound({
        channel, conversation,
        skillEndpoint: "/poll",
        payload: { conversation, question, options, isAnonymous, allowsMultiple },
      });
      const pollId = (res as any)?.pollId;
      return { content: [{ type: "text" as const, text: `Poll created${pollId ? ` (id: ${pollId})` : ""}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);
```

**Step 7: Add `get_message` tool (routes to Skill)**

```typescript
const getMessage = tool(
  "get_message",
  "Fetch a specific message from chat history. Returns full content including images. Use when you need to see a referenced message not in your current session (e.g. from a reply-to reference).",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    date: z.string().describe("Date string (e.g. '2026-03-13')"),
    seq: z.number().optional().describe("Message seq number within that day's file"),
    platformMessageId: z.number().optional().describe("Platform-specific message ID (alternative to seq)"),
  },
  async ({ channel, conversation, date, seq, platformMessageId }) => {
    try {
      const endpoint = skillServiceManager.getEndpoint(channel);
      if (!endpoint) return { content: [{ type: "text" as const, text: `No skill for channel: ${channel}` }], isError: true };

      const res = await fetch(`${endpoint}/get_message`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation, date, seq, messageId: platformMessageId }),
      });
      if (!res.ok) return { content: [{ type: "text" as const, text: `Not found: ${await res.text()}` }], isError: true };

      const data = await res.json() as {
        message: Record<string, unknown>;
        attachments: { mimeType: string; data: string }[];
      };

      const blocks: any[] = [];
      const msg = data.message;
      const sender = (msg.sender as any)?.name ?? "Unknown";
      blocks.push({ type: "text" as const, text: `[${date}/seq:${msg.seq}] ${sender} (${msg.type}):` });

      if (msg.text) blocks.push({ type: "text" as const, text: String(msg.text) });
      if (msg.caption) blocks.push({ type: "text" as const, text: String(msg.caption) });

      for (const att of data.attachments) {
        if (att.mimeType.startsWith("image/")) {
          blocks.push({ type: "image" as const, data: att.data, mimeType: att.mimeType });
        } else {
          blocks.push({ type: "text" as const, text: `[attachment: ${att.mimeType}]` });
        }
      }

      if (msg.emoji) blocks.push({ type: "text" as const, text: `emoji: ${msg.emoji}` });

      return { content: blocks };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);
```

**Step 8: Register all new tools**

```typescript
tools: [
  sendMessage, skipReply, updateProgress, getQueueStatus,
  reactMessage, editMessage, deleteMessage,
  sendSticker, getStickerSet, sendPoll, getMessage,
  startSkillService, stopSkillService, listSkillServices,
],
```

**Step 9: Commit**

```bash
git add packages/agent-runtime/src/sdk-mcp-tools.ts
git commit -m "feat: 7 new MCP tools (react/edit/delete/sticker/poll/get_message)"
```

---

### Task 6: Agent Loop Update

**Files:**
- Modify: `packages/agent-runtime/src/agent-loop.ts`

`formatMessageForAgent` 变为纯透传：text 直传、image 转 SDK content blocks。删除所有 Skill 特有逻辑和不再需要的下载函数。

**Step 1: Delete unused functions**

Remove:
- `detectImageType` (lines 39-46) — Skill now provides mimeType
- `downloadImageAsBase64` (lines 52-72) — Skill now provides base64 inline
- `safeSlice` (lines 75-79) — moved to Skill
- `PREVIEW_LIMIT` (line 81) — moved to Skill
- `formatSize` (lines 83-87) — moved to Skill

**Step 2: Rewrite `formatMessageForAgent` as pure pass-through**

Replace lines 93-138:

```typescript
/**
 * Convert InboundMessage content to SDK-compatible format.
 * Skill has already formatted notification text and embedded metadata.
 * This function only handles the generic MessageContent → SDK conversion.
 */
async function formatMessageForAgent(msg: InboundMessage): Promise<MessageParam["content"]> {
  if (msg.content.type === "text") {
    return msg.content.text;
  }

  if (msg.content.type === "image") {
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (msg.content.caption) {
      blocks.push({ type: "text", text: msg.content.caption });
    }
    if (msg.content.data && msg.content.mimeType) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: msg.content.mimeType, data: msg.content.data },
      });
    }
    return blocks.length > 0 ? blocks : `[${msg.channel}] image without data`;
  }

  return `[${msg.channel}] unsupported content type: ${msg.content.type}`;
}
```

**Step 3: Update `SDK_SYSTEM_APPEND`**

Replace lines 160-185. The prompt no longer describes message format in detail (Skill handles that). Focus on tools and behavior:

```typescript
const SDK_SYSTEM_APPEND = `You are CodeClaw, a personal AI agent running inside a Docker container.
Your home directory is ~ (/home/codeclaw). This is your persistent workspace.

You receive messages from various channels (Telegram, web, etc.) via a message queue.
Each message includes metadata embedded in the content text by the channel Skill.

TOOLS:
- send_message: Reply to users on their channel
- react_message: Add emoji reactions on messages (acknowledge, express emotions)
- edit_message / delete_message: Modify or remove messages
- get_sticker_set + send_sticker: Browse sticker sets with visual thumbnails, then send
- send_poll: Create polls
- get_message: Fetch historical messages from a channel's persistent storage
- update_progress: Show progress for long-running tasks
- skip_reply: Acknowledge without replying (useful in groups)

RULES:
- Extract channel and conversation ID from the message header [channel/chatId]
- Messages may include reply-to references — use get_message to fetch if needed
- Long text may be truncated; full text available in the channel's persistent storage
- Each channel Skill stores data in ~/.claude/data/<channel>/. Read the Skill's SKILL.md for format details.
- Keep responses concise and helpful

DIRECTORY STRUCTURE:
- ~/.claude/skills/     — Installed skills (each has SKILL.md)
- ~/.claude/data/       — Skill persistent data (chat logs, files)
- ~/.claude/cache/      — Temporary files (safe to clean)
- ~/.claude/memory/     — Your long-term memory
- ~/.claude/config/     — Configuration files
- ~/Projects/           — Create project directories here as needed

GROUP CHAT:
- You only receive messages that @mention you or reply to you
- Other messages are stored by the channel Skill but not forwarded
- Use get_message or read the Skill's data files for prior context
- Use skip_reply to acknowledge without sending a reply`;
```

**Step 4: Commit**

```bash
git add packages/agent-runtime/src/agent-loop.ts
git commit -m "refactor: formatMessageForAgent as pure pass-through, remove download functions"
```

---

### Task 7: Update Documentation

**Files:**
- Modify: `workspace-template/CLAUDE.md`
- Modify: `skills/telegram/SKILL.md`
- Modify: `docs/progress.md`

Only modify `workspace-template/CLAUDE.md` (source). NOT `.agent-home/CLAUDE.md` (runtime mount).

Telegram-specific details (JSONL path, seq format, reply-to reference format) go in SKILL.md, NOT in workspace-template/CLAUDE.md or SDK_SYSTEM_APPEND. Agent reads SKILL.md when it needs channel-specific knowledge.

**Step 1: Update workspace-template/CLAUDE.md**

Add to "如何与用户通信" (generic tools only, no Telegram-specific formats):

```markdown
- 收到消息后，先用 react_message 对用户消息打个 emoji 反应，再开始处理
- 使用 edit_message 编辑你之前发送的消息
- 使用 delete_message 删除消息
- 想发贴纸时，先用 get_sticker_set 浏览贴纸包（会自动显示"正在选择贴纸"），选好后用 send_sticker 发送
- 使用 send_poll 创建投票
- 使用 get_message 获取不在当前 session 内的历史消息
- 各通道的消息格式和存储结构详见 ~/.claude/skills/<channel>/SKILL.md
```

**Step 2: Update skills/telegram/SKILL.md**

Add "聊天记录" section (Telegram-specific details belong here, not in framework-level docs):

```markdown
## 聊天记录

消息持久化存储在 `~/.claude/data/telegram/` 目录下，按日期分目录。

### 目录结构
```
~/.claude/data/telegram/
├── 2026-03-13/
│   ├── -123456789.jsonl     # 群聊/DM 聊天记录
│   └── -123456789/
│       └── files/           # 消息中的图片/文件/贴纸
│           ├── 42_photo.jpg
│           └── 55_sticker.webp
```

### JSONL 格式
- 每行一条 JSON 记录，字段: `seq`, `ts`, `tgMsgId`, `sender`, `type`, ...
- `seq` 从 0 开始，按天重置，连续递增
- `type`: `text` | `image` | `sticker` | `file` | `audio` | `other`

### 消息引用
- 收到的消息头部可能包含 `reply-to:2026-03-13/-123456789/tgMsgId:38`
- 格式: `<date>/<chatId>/tgMsgId:<id>`
- 使用 `get_message` 工具查询: channel="telegram", conversation=chatId, date=date, platformMessageId=tgMsgId
- 也可以直接 Grep JSONL 文件

### get_message 查询
- 按 seq 查询: `date="2026-03-13"`, `seq=5`
- 按 Telegram 消息 ID 查询: `date="2026-03-13"`, `platformMessageId=38`
```

**Step 3: Update docs/progress.md**

- MCP tool count: 7 → 14
- New milestones: JSONL refactor, circuit breaker, rich tools, Skill-side formatting
- Updated Telegram Skill API reference with all new endpoints
- Architecture note: Skill formats notifications, Agent Runtime is pure pass-through
- Outbound routing: `send_message`/`edit_message`/`send_sticker`/`send_poll` through Kernel; `react`/`delete`/`get_sticker_set`/`get_message` direct to Skill

**Step 4: Commit**

```bash
git add workspace-template/CLAUDE.md skills/telegram/SKILL.md docs/progress.md
git commit -m "docs: update for Telegram enhancements (JSONL, rich tools, Skill-side formatting)"
```

---

## Verification

```bash
# Build
docker build -t codeclaw/agent-runtime:dev -f packages/agent-runtime/Dockerfile.dev .

# Deploy
docker stop codeclaw-agent-andy && docker rm codeclaw-agent-andy
docker run -d --name codeclaw-agent-andy \
  -v /Users/zhaoqixuan/Projects/CodeClaw/.agent-home:/home/codeclaw \
  -p 7001-7099:7001-7099 \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID=andy \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e ANTHROPIC_BASE_URL="https://proxy.moedb.moe" \
  -e CLAUDE_MODEL="aws-claude-opus-4-6" \
  -e HTTP_PROXY="http://host.docker.internal:7890" \
  -e HTTPS_PROXY="http://host.docker.internal:7890" \
  -e https_proxy="http://host.docker.internal:7890" \
  -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  codeclaw/agent-runtime:dev
```

**Test checklist:**
1. DM 发文本 → Agent 收到带 seq/date/jsonlPath 的格式化通知
2. DM 发图片 → Agent 收到 multimodal (header text + base64 image)
3. DM 发静态贴纸 → Agent 收到 webp base64 image
4. DM 发动画贴纸 → Agent 收到文字占位符 `[贴纸 ...]`
5. DM 发文件 → Agent 收到 `[文件: xxx, 1.2KB]`
6. DM 发语音 → Agent 收到 `[语音消息, 5秒]`
7. 回复一条旧消息 → `ensureReplyPersisted` 写入 JSONL，Agent 看到 `reply-to:date/chatId/tgMsgId:N`
8. 群聊普通消息 → 存 JSONL 不转发
9. 群聊 @bot → Agent 只收到该条消息
10. Agent 浏览贴纸 → choose_sticker 状态 + 缩略图
11. Agent 发贴纸 → 贴纸发出 + JSONL 记录
12. Agent 投票/反应/编辑/删除 → 全部正常
13. 检查 JSONL 目录结构: `~/.claude/data/telegram/2026-03-13/<chatId>.jsonl`
14. 401 熔断器: 模拟 401 错误，检查日志退避行为
