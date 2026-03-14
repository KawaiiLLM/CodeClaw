# Home 目录迁移 + 文件系统即上下文 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 CodeClaw 从 `/workspace` 项目目录模型迁移到 `~/` 用户主目录模型，同时实现"文件系统即上下文"哲学——聊天记录由 Skill 持久化为 JSONL，Agent 收到手机通知风格的消息摘要，按需 Read/Grep 完整内容。

**Architecture:** 7 个文件的协调修改。路径常量从 `/workspace` 改为 `/home/codeclaw`（即容器内的 `~`）。Telegram Skill 新增 JSONL 写入逻辑，每条消息追加到 `~/.claude/data/telegram/{chatId}.jsonl`，文件保存到同级 `files/` 目录。Agent-loop 的消息格式从全文展示改为通知风格摘要（短文完整显示，长文/文件只显示概要+路径）。移除 inbox 概念。

**Tech Stack:** TypeScript ESM, Docker, Node.js, Grammy (Telegram), Claude Agent SDK

**设计哲学参考:** `docs/architecture.md` 第二章"文件系统即上下文"

---

## 变更概览

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `packages/types/src/messages.ts` | 修改 | file 类型加 `path`/`size`，去 `data` |
| 2 | `packages/agent-runtime/Dockerfile.dev` | 修改 | `/workspace` → `/home/codeclaw`，创建 `.claude` 子目录 |
| 3 | `packages/agent-runtime/Dockerfile` | 修改 | 同上（生产镜像） |
| 4 | `packages/kernel/src/container-manager.ts` | 修改 | bind mount + WorkingDir |
| 5 | `packages/agent-runtime/src/index.ts` | 修改 | 默认路径改为 `$HOME` |
| 6 | `skills/telegram/service.ts` | 修改 | JSONL 持久化、文件存 `data/`、config 路径 |
| 7 | `skills/telegram/MANUAL.md` → `SKILL.md` | 重命名+重写 | 对齐开放标准命名 |
| 8 | `packages/agent-runtime/src/agent-loop.ts` | 修改 | 通知风格格式、移除 inbox、更新 system prompt |

---

## JSONL 消息格式规范

每条消息一行 JSON，格式：

```jsonl
{"id":"tg_-12345_100","ts":1710300000,"sender":{"id":"123","name":"Alice"},"type":"text","text":"今天天气怎么样","replyTo":null}
{"id":"tg_-12345_101","ts":1710300005,"sender":{"id":"123","name":"Alice"},"type":"file","filename":"report.md","path":"files/report.md","size":3400,"mimeType":"text/markdown","caption":"看看这个"}
{"id":"tg_-12345_102","ts":1710300010,"sender":{"id":"bot","name":"Andy"},"type":"text","text":"好的，我来看看","replyTo":"tg_-12345_100"}
```

字段说明：
- `id`: 唯一 ID，格式 `tg_{chatId}_{messageId}`
- `ts`: Unix 毫秒时间戳
- `sender`: 发送者信息
- `type`: `text` | `image` | `file` | `audio`
- `text`: 文本内容（text 类型必有）
- `filename` / `path` / `size` / `mimeType`: 文件类型的元数据
- `path`: 相对于 JSONL 文件所在目录的路径（如 `files/report.md`）
- `caption`: 文件/图片的附加文字
- `replyTo`: 引用消息的 id（null 表示无引用）

存储位置：`~/.claude/data/telegram/{chatId}.jsonl`
文件存储：`~/.claude/data/telegram/{chatId}/files/{msgId}_{filename}`

---

## 通知风格消息格式

Agent 收到的消息应像手机通知——显示发送者和内容概要：

```
短文本 (≤200 字符):
[telegram] Alice: 今天天气怎么样

长文本 (>200 字符):
[telegram] Alice: 这是一篇关于人工智能在医疗领域应用的详细分析报告，主要涵盖了以下几个方面：首先是...
  → full text in ~/.claude/data/telegram/-12345.jsonl (id: tg_-12345_100)

文件:
[telegram] Alice: [file] report.md (3.4KB)
  → ~/.claude/data/telegram/-12345/files/tg_-12345_101_report.md

图片（仍包含 base64 用于 Vision）:
[telegram] Alice: [image] 看看这张照片
  → saved to ~/.claude/data/telegram/-12345/files/tg_-12345_102_photo.jpg

引用上下文（由 Skill 拼接，Agent 可用 id 在 JSONL 中 Grep）:
[telegram] Alice (replying to tg_-12345_50): 我同意你的观点
```

---

## Task 1: 更新消息类型定义

**Files:**
- Modify: `packages/types/src/messages.ts`

**Step 1: 修改 MessageContent 类型**

file 类型：去掉 `data`（不再 base64 传输），加 `path`（本地文件路径）和 `size`（字节数）。
image 类型：加可选 `path`（本地存储路径）。

```typescript
/**
 * Cross-channel unified message formats.
 */

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; path?: string; caption?: string }
  | { type: "audio"; url?: string; path?: string; duration?: number }
  | { type: "file"; filename: string; path?: string; size?: number; url?: string; mimeType?: string };

export interface InboundMessage {
  id: string;
  channel: string; // "telegram", "web", "cli"
  sender: {
    id: string;
    name: string;
    channel: string;
  };
  conversation: {
    id: string; // Group ID / DM ID
    type: "group" | "dm";
    title?: string;
  };
  content: MessageContent;
  timestamp: number;
  replyTo?: string;
}

export interface OutboundMessage {
  channel: string;
  conversation: string;
  content: MessageContent;
  replyTo?: string;
}
```

**Step 2: 构建验证**

Run: `pnpm exec tsc --noEmit -p packages/types/tsconfig.json 2>&1`
Expected: 无错误（类型变更是兼容的——加字段、改可选）

**Step 3: Commit**

```bash
git add packages/types/src/messages.ts
git commit -m "refactor(types): file content uses path instead of data, add size field"
```

---

## Task 2: Docker 镜像迁移到 home 目录

**Files:**
- Modify: `packages/agent-runtime/Dockerfile.dev`
- Modify: `packages/agent-runtime/Dockerfile`

**Step 1: 修改 Dockerfile.dev**

关键变更：
- `VOLUME` 和 `WORKDIR` 从 `/workspace` 改为 `/home/codeclaw`
- 创建 `.claude` 子目录结构
- home 目录归属于 codeclaw 用户

```dockerfile
FROM node:22-slim

# Use USTC Debian mirror for faster downloads in China
RUN sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list 2>/dev/null; \
    true

# Install common tools
RUN apt-get update && apt-get install -y \
    git curl wget jq sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Use npmmirror for faster npm downloads in China
RUN npm config set registry https://registry.npmmirror.com

# Install tsx globally for running TypeScript directly
RUN npm install -g tsx

# Copy the entire monorepo source (needed for workspace: dependencies)
WORKDIR /codeclaw
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/types/ packages/types/
COPY packages/agent-runtime/ packages/agent-runtime/

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm config set registry https://registry.npmmirror.com && pnpm install --no-frozen-lockfile

# Create non-root user with explicit UID (Claude Code SDK refuses bypassPermissions as root)
RUN userdel -r node && \
    useradd -u 1000 -m -s /bin/bash codeclaw && \
    mkdir -p /home/codeclaw/.claude/{skills,data,cache,memory,config} && \
    chown -R codeclaw:codeclaw /home/codeclaw

# Home directory is mounted as a volume for persistence
VOLUME /home/codeclaw
WORKDIR /home/codeclaw

USER codeclaw

# Start agent runtime with tsx
CMD ["tsx", "/codeclaw/packages/agent-runtime/src/index.ts"]
```

**Step 2: 修改 Dockerfile (生产镜像)**

```dockerfile
FROM node:22-slim

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install common tools
RUN apt-get update && apt-get install -y \
    git curl wget jq sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Copy agent-runtime
WORKDIR /app
COPY packages/agent-runtime/dist/ /app/
COPY packages/agent-runtime/package.json /app/
RUN npm install --omit=dev

# Create non-root user
RUN useradd -u 1000 -m -s /bin/bash codeclaw && \
    mkdir -p /home/codeclaw/.claude/{skills,data,cache,memory,config} && \
    chown -R codeclaw:codeclaw /home/codeclaw

# Home directory is mounted as a volume for persistence
VOLUME /home/codeclaw
WORKDIR /home/codeclaw

USER codeclaw

# Start agent runtime
CMD ["node", "/app/index.js"]
```

**Step 3: Commit**

```bash
git add packages/agent-runtime/Dockerfile.dev packages/agent-runtime/Dockerfile
git commit -m "refactor(docker): migrate from /workspace to /home/codeclaw"
```

---

## Task 3: Kernel 容器管理路径更新

**Files:**
- Modify: `packages/kernel/src/container-manager.ts:75-85`

**Step 1: 修改 bind mount 和 WorkingDir**

```typescript
// 在 createAgent 方法中，将:
    HostConfig: {
        Binds: [`${config.workspaceVolume}:/workspace`],
// 改为:
    HostConfig: {
        Binds: [`${config.workspaceVolume}:/home/codeclaw`],

// 将:
      WorkingDir: "/workspace",
// 改为:
      WorkingDir: "/home/codeclaw",
```

**Step 2: Commit**

```bash
git add packages/kernel/src/container-manager.ts
git commit -m "refactor(kernel): container bind mount to /home/codeclaw"
```

---

## Task 4: Agent Runtime 入口路径更新

**Files:**
- Modify: `packages/agent-runtime/src/index.ts:10`

**Step 1: 改默认路径**

```typescript
// 将:
  const workspacePath = process.env.WORKSPACE_PATH ?? "/workspace";
// 改为:
  const workspacePath = process.env.HOME ?? "/home/codeclaw";
```

> 注意：`workspacePath` 变量名暂时保留，避免大范围重命名。语义上它现在是 home 目录。

**Step 2: Commit**

```bash
git add packages/agent-runtime/src/index.ts
git commit -m "refactor(agent-runtime): default path from HOME instead of /workspace"
```

---

## Task 5: Telegram Skill — JSONL 持久化 + 文件存储

**Files:**
- Modify: `skills/telegram/service.ts`
- Rename: `skills/telegram/MANUAL.md` → `skills/telegram/SKILL.md`

这是最大的改动。Telegram Skill 需要：
1. 改 config 路径
2. 新增 JSONL 写入函数
3. 每条 inbound 消息写入 JSONL
4. 文件下载后存到 `~/.claude/data/telegram/{chatId}/files/`
5. 转发给 kernel 时不再传 base64 data，改传本地 path
6. 出站消息也写入 JSONL

**Step 1: 修改 CONFIG_PATH 和新增数据目录常量**

```typescript
// 将:
const CONFIG_PATH = process.env.CONFIG_PATH ?? "/workspace/config/telegram.json";
// 改为:
const HOME = process.env.HOME ?? "/home/codeclaw";
const CONFIG_PATH = process.env.CONFIG_PATH ?? `${HOME}/.claude/config/telegram.json`;
const DATA_DIR = `${HOME}/.claude/data/telegram`;
```

**Step 2: 新增 JSONL 写入和文件存储工具函数**

在 `main()` 函数内、helpers 区域新增：

```typescript
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// （在 main 内部）

/** Ensure directory exists. */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Append one JSONL record to the conversation log. */
function appendToLog(chatId: string, record: Record<string, unknown>): void {
  ensureDir(DATA_DIR);
  const logPath = join(DATA_DIR, `${chatId}.jsonl`);
  appendFileSync(logPath, JSON.stringify(record) + "\n");
}

/** Save a file to the conversation's files/ directory. Returns the relative path (for JSONL). */
function saveFile(chatId: string, msgId: string, filename: string, buf: Buffer): { absPath: string; relPath: string } {
  const filesDir = join(DATA_DIR, chatId, "files");
  ensureDir(filesDir);
  const safeName = `${msgId}_${filename}`;
  const absPath = join(filesDir, safeName);
  writeFileSync(absPath, buf);
  const relPath = `files/${safeName}`;
  return { absPath, relPath };
}
```

**Step 3: 修改 inbound 消息处理——每种类型都写 JSONL**

在每个消息处理分支中，`forwardToKernel` 之前/之后加入 `appendToLog`。

**文本消息（msg.text != null 分支）：**

```typescript
// 在 forwardToKernel 调用之后追加：
appendToLog(String(ctx.chat.id), {
  id: baseId, ts: timestamp,
  sender: { id: sender.id, name: sender.name },
  type: "text", text: msg.text,  // 原始完整文本（未去 @mention）
  replyTo: msg.reply_to_message ? `tg_${ctx.chat.id}_${msg.reply_to_message.message_id}` : null,
});
```

**文件消息（msg.document 分支）：**

下载文件后不再 base64 编码传 kernel，改为存本地 + 传 path：

```typescript
} else if (msg.document) {
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

    // Log to JSONL
    appendToLog(String(ctx.chat.id), {
      id: baseId, ts: timestamp,
      sender: { id: sender.id, name: sender.name },
      type: "file", filename: fileName, path: relPath,
      size: buf.length, mimeType: doc.mime_type ?? null,
      caption: caption || null,
      replyTo: msg.reply_to_message ? `tg_${ctx.chat.id}_${msg.reply_to_message.message_id}` : null,
    });

    // Forward to kernel with local path (no base64)
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
    // ... 保持原有 fallback 逻辑
  }
}
```

**图片消息（msg.photo 分支）：**

同样下载保存到 files/ 目录，但仍通过 URL 转发（agent-loop 需要下载用于 Vision）：

```typescript
// 在 forwardToKernel 之后追加：
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
```

**Step 4: 出站消息也写 JSONL**

在 HTTP server 的 `/send` handler 中，`bot.api.sendMessage` 成功后追加：

```typescript
// 发送成功后记录到 JSONL
appendToLog(conversation, {
  id: `tg_${conversation}_out_${Date.now()}`,
  ts: Date.now(),
  sender: { id: "bot", name: "Agent" },
  type: "text", text: content.text,
  replyTo: replyTo ?? null,
});
```

**Step 5: 重命名 MANUAL.md → SKILL.md 并更新内容**

```bash
mv skills/telegram/MANUAL.md skills/telegram/SKILL.md
```

新内容：

```markdown
# Telegram 通道 Skill

## 功能
收发 Telegram 消息。支持文本、图片、文件。

## 数据目录
- 聊天记录: `~/.claude/data/telegram/{chatId}.jsonl`
- 文件附件: `~/.claude/data/telegram/{chatId}/files/`
- 配置文件: `~/.claude/config/telegram.json`

## 安装步骤
1. 确保 `~/.claude/config/telegram.json` 存在且包含 bot_token
2. 安装依赖: `cd ~/.claude/skills/telegram && npm install`
3. 启动服务: 使用 start_skill_service 工具
   - skillId: "telegram"
   - command: "node"
   - args: ["~/.claude/skills/telegram/service.js"]

## 配置 (~/.claude/config/telegram.json)
{
  "bot_token": "必填, 从 @BotFather 获取",
  "allowed_users": ["可选, Telegram user ID 白名单, 留空则允许所有人"]
}

## JSONL 格式
每条消息一行 JSON:
{"id":"tg_-12345_100","ts":1710300000,"sender":{"id":"123","name":"Alice"},"type":"text","text":"...","replyTo":null}

引用关系通过 id 字段关联，不嵌入被引用的文本内容。

## 查阅聊天记录
- 搜索特定关键词: `grep "关键词" ~/.claude/data/telegram/-12345.jsonl`
- 查看最近消息: `tail -20 ~/.claude/data/telegram/-12345.jsonl`
- 按消息 ID 查找: `grep "tg_-12345_100" ~/.claude/data/telegram/-12345.jsonl`
```

**Step 6: Commit**

```bash
git add skills/telegram/service.ts
git rm skills/telegram/MANUAL.md
git add skills/telegram/SKILL.md
git commit -m "feat(telegram): JSONL chat persistence, file storage, rename to SKILL.md"
```

---

## Task 6: Agent-Loop — 通知风格格式 + 移除 inbox

**Files:**
- Modify: `packages/agent-runtime/src/agent-loop.ts`

这是第二大改动。核心变更：
1. 移除 `INBOX_DIR`、`saveInboxFile`、`readdirSync` 导入
2. 重写 `formatMessageForAgent()` 为通知风格
3. 更新 `SDK_SYSTEM_APPEND` 引用新路径和行为
4. `cwd` 改用 home 目录

**Step 1: 清理导入和移除 inbox**

```typescript
// 将第 1 行:
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
// 改为:
import { homedir } from "node:os";
```

删除第 40-63 行的 `INBOX_DIR` 和 `saveInboxFile` 函数。

**Step 2: 重写 formatMessageForAgent()**

```typescript
const PREVIEW_LIMIT = 200; // 短文本阈值（字符数）

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format an inbound message as a phone-notification-style summary.
 * Short text shown in full; long text/files show preview + path for Read/Grep.
 */
async function formatMessageForAgent(msg: InboundMessage): Promise<MessageParam["content"]> {
  const tag = `[${msg.channel}]`;
  const sender = msg.sender.name;
  const replyTag = msg.replyTo ? ` (replying to ${msg.replyTo})` : "";

  if (msg.content.type === "text") {
    const text = msg.content.text;
    if (text.length <= PREVIEW_LIMIT) {
      return `${tag} ${sender}${replyTag}: ${text}`;
    }
    // Long text: show preview + reference
    const preview = text.slice(0, 100) + "...";
    const dataDir = `~/.claude/data/${msg.channel}`;
    return `${tag} ${sender}${replyTag}: ${preview}\n  → full text in ${dataDir}/${msg.conversation.id}.jsonl (id: ${msg.id})`;
  }

  if (msg.content.type === "image") {
    const caption = msg.content.caption || "[image]";
    // Still include base64 for Vision if URL available
    if (msg.content.url) {
      const imageSource = await downloadImageAsBase64(msg.content.url);
      const blocks: Anthropic.ContentBlockParam[] = [
        { type: "image", source: imageSource as any },
      ];
      const textLine = msg.content.path
        ? `${tag} ${sender}${replyTag}: ${caption}\n  → ${msg.content.path}`
        : `${tag} ${sender}${replyTag}: ${caption}`;
      blocks.push({ type: "text", text: textLine });
      return blocks;
    }
    // No URL (shouldn't happen normally), just text notification
    return `${tag} ${sender}${replyTag}: ${caption}`;
  }

  if (msg.content.type === "audio") {
    const dur = msg.content.duration ? ` ${msg.content.duration}s` : "";
    const pathRef = msg.content.path ? `\n  → ${msg.content.path}` : "";
    return `${tag} ${sender}${replyTag}: [audio${dur}]${pathRef}`;
  }

  if (msg.content.type === "file") {
    const name = msg.content.filename;
    const size = msg.content.size ? ` (${formatSize(msg.content.size)})` : "";
    const pathRef = msg.content.path ? `\n  → ${msg.content.path}` : "";
    return `${tag} ${sender}${replyTag}: [file] ${name}${size}${pathRef}`;
  }

  return `${tag} ${sender}${replyTag}: [unknown content]`;
}
```

**Step 3: 更新 SDK_SYSTEM_APPEND**

```typescript
const SDK_SYSTEM_APPEND = `You are CodeClaw, a personal AI agent running inside a Docker container.
Your home directory is ~ (/home/codeclaw). This is your persistent workspace.

You receive messages from various channels (Telegram, web, etc.) via a message queue.
Messages are formatted as notifications: [channel] Sender: content preview.

IMPORTANT RULES:
- Use the send_message MCP tool to reply to users on their channel.
- When replying, use the channel name from the [channel] tag and the conversation ID from the message metadata.
- For long messages or files, the full content path is shown after "→". Use Read or Grep to access it.
- Chat history is persisted as JSONL in ~/.claude/data/<channel>/. Use Grep to search past conversations.
- Keep responses concise and helpful.

DIRECTORY STRUCTURE:
- ~/.claude/skills/     — Installed skills (each has SKILL.md)
- ~/.claude/data/       — Skill persistent data (chat logs, files)
- ~/.claude/cache/      — Temporary files (safe to clean)
- ~/.claude/memory/     — Your long-term memory
- ~/.claude/config/     — Configuration files
- ~/Projects/           — Create project directories here as needed

GROUP CHAT BEHAVIOR:
- Messages prefixed with "[Recent group messages ... unread]" include context from before you were @mentioned.
- Messages marked "[Active window message — reply only if relevant]" are from an ongoing group conversation.
  You are NOT required to reply to every active window message. Only reply when you have something useful to add.
  Use the skip_reply MCP tool to acknowledge a message without sending a reply.`;
```

**Step 4: 更新 cwd**

在 `runSdkLoop()` 中：

```typescript
// 将:
      cwd: workspacePath,
// 改为:
      cwd: process.env.HOME ?? workspacePath,
```

**Step 5: 更新 SYSTEM_PROMPT (chat 模式)**

```typescript
const SYSTEM_PROMPT = `You are CodeClaw, a personal AI assistant running inside a Docker container.
Your home directory ~ is your persistent workspace.
You receive messages from various channels (Telegram, web, etc.) via a message queue.
Messages are formatted as notifications: [channel] Sender: content.
Reply naturally and helpfully. Keep responses concise.
You can use markdown formatting in your replies.`;
```

**Step 6: Commit**

```bash
git add packages/agent-runtime/src/agent-loop.ts
git commit -m "refactor(agent-loop): notification-style messages, remove inbox, use home dir"
```

---

## Task 7: 更新 workspace-template 目录结构

**Files:**
- 重组: `workspace-template/` 目录

当前结构:
```
workspace-template/
├── CLAUDE.md
├── config/
│   ├── agent.yaml
│   ├── telegram.json
│   └── telegram.json.example
├── memory/.gitkeep
├── skills/.gitkeep
└── scratch/.gitkeep
```

目标结构（匹配 home 目录模型）：
```
workspace-template/
├── CLAUDE.md                          # 已在之前的 task 中更新
└── .claude/
    ├── skills/.gitkeep
    ├── data/.gitkeep
    ├── cache/.gitkeep
    ├── memory/.gitkeep
    └── config/
        ├── telegram.json.example
        └── agent.yaml
```

**Step 1: 重组目录**

```bash
cd workspace-template
mkdir -p .claude/{skills,data,cache,memory,config}
mv config/telegram.json.example .claude/config/
mv config/agent.yaml .claude/config/
rm -rf config memory skills scratch
mv .claude/config/telegram.json.example .claude/config/
touch .claude/{skills,data,cache,memory}/.gitkeep
```

> 注意：`config/telegram.json` 如果是真实 token 文件则在 .gitignore 中，不移动。

**Step 2: Commit**

```bash
git add workspace-template/
git commit -m "refactor(workspace-template): restructure to home directory model"
```

---

## Task 8: 构建验证

**Step 1: TypeScript 编译检查**

```bash
pnpm exec tsc --noEmit 2>&1
```

Expected: 无编译错误

**Step 2: Docker 镜像构建**

```bash
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock \
docker build -t codeclaw/agent-runtime:dev \
  -f packages/agent-runtime/Dockerfile.dev .
```

Expected: 构建成功

**Step 3: 验证容器内目录结构**

```bash
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock \
docker run --rm codeclaw/agent-runtime:dev \
  ls -la /home/codeclaw/.claude/
```

Expected: 显示 skills, data, cache, memory, config 目录

**Step 4: Final commit (如有修复)**

```bash
git add -A
git commit -m "fix: address build issues from home directory migration"
```

---

## 依赖关系

```
Task 1 (types)
    ↓
Task 2 (Dockerfile) ──→ Task 8 (构建验证)
    ↓
Task 3 (container-manager)
    ↓
Task 4 (index.ts)
    ↓
Task 5 (telegram service) ──┐
    ↓                        ↓
Task 6 (agent-loop) ────→ Task 8
    ↓
Task 7 (workspace-template)
```

Task 1-4 可以快速顺序执行（每个都很小）。Task 5 和 6 是核心改动，互相有类型依赖（Task 1 先行）。Task 7 独立。Task 8 最后验证。

---

## 不修改的文件

| 文件 | 原因 |
|------|------|
| `sdk-mcp-tools.ts` | MCP 工具定义不涉及路径 |
| `mcp-server.ts` | 同上 |
| `message-injector.ts` | 纯消息轮询逻辑，不涉及路径 |
| `kernel-client.ts` | HTTP 客户端，不涉及路径 |
| `skill-service-manager.ts` | 进程管理，不涉及路径 |
| `logger.ts` | 日志工具 |
