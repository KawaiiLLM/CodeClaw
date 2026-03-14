# Skill MCP 封装：Telegram 工具从 Agent Runtime 迁移到 Skill 独立 stdio 进程

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Telegram MCP 工具从 Agent Runtime in-process 迁移为 Skill 目录下的 stdio 独立子进程，遵循 Claude Code Plugin 标准，实现 Skill + MCP 打包。

**Architecture:** 每个 Skill 目录包含 SKILL.md（操作手册）+ mcp-server.ts（stdio MCP 进程）。Agent Runtime 通过 SDK 的 `McpStdioServerConfig` 注册外部 MCP server，不再持有任何工具定义。Agent Runtime 退化为纯 SDK 驱动层 + 事件流观察者。

**Tech Stack:** `@modelcontextprotocol/sdk`（stdio MCP server）、`@anthropic-ai/claude-agent-sdk`（McpStdioServerConfig）、TypeScript ESM

---

## 变更概览

| 文件 | 操作 | 说明 |
|------|------|------|
| `skills/telegram/mcp-server.ts` | **新建** | stdio MCP server，8 tools，自带 HTTP client |
| `skills/telegram/SKILL.md` | 修改 | 移除 skip_reply/show_progress，更新工具列表和群聊指导 |
| `skills/telegram/manifest.json` | 修改 | 添加 `mcpEntrypoint` 字段 |
| `packages/agent-runtime/src/agent-loop.ts` | 修改 | mcpServers 改为 stdio 配置，删除 MCP 回调，typing 改为事件流检测 |
| `packages/agent-runtime/src/progress-tracker.ts` | 修改 | HIDDEN_TOOLS 更新 tool 命名前缀 |
| `packages/agent-runtime/src/sdk-mcp-tools.ts` | **删除** | 全部职责迁移至 Skill |
| `packages/agent-runtime/src/index.ts` | 修改 | 扫描 manifest 组装 mcpServers 配置传给 agent-loop |

---

### Task 1: 新建 Telegram stdio MCP server

**Files:**
- Create: `skills/telegram/mcp-server.ts`

**Step 1: 创建 MCP server 文件**

```typescript
// skills/telegram/mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Kernel HTTP client (self-contained, no import from agent-runtime) ---

const KERNEL_URL = process.env.KERNEL_URL ?? "http://localhost:19000";
const SKILL_ENDPOINT = process.env.SKILL_ENDPOINT; // e.g. "http://localhost:7001"

async function kernelPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${KERNEL_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Kernel POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sendMessage(msg: {
  channel: string;
  conversation: string;
  text: string;
  replyTo?: string;
  editMessageId?: string;
}): Promise<{ messageId?: string }> {
  return kernelPost("/api/messages/outbound", {
    channel: msg.channel,
    conversation: msg.conversation,
    content: { type: "text", text: msg.text },
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.editMessageId ? { editMessageId: msg.editMessageId } : {}),
  });
}

async function sendOutbound(msg: {
  channel: string;
  conversation: string;
  skillEndpoint: string;
  payload: Record<string, unknown>;
}): Promise<any> {
  return kernelPost("/api/messages/outbound", {
    channel: msg.channel,
    conversation: msg.conversation,
    content: { type: "text", text: "" },
    skillEndpoint: msg.skillEndpoint,
    payload: msg.payload,
  });
}

// --- MCP Server ---

const server = new McpServer({ name: "telegram", version: "0.1.0" });

server.tool(
  "send_message",
  "Send a message to a Telegram conversation. In group chats, listenMinutes opens a window to receive all group messages (not just @mentions) after sending.",
  {
    channel: z.string().describe("Target channel (e.g. 'telegram')"),
    conversation: z.string().describe("Conversation/chat ID"),
    text: z.string().describe("Message text to send"),
    replyTo: z.string().optional().describe("Message ID to reply to"),
    listenMinutes: z.number().min(0).max(1440).optional().describe("Minutes to listen for all group messages after sending (default 3, 0 to disable)"),
  },
  async ({ channel, conversation, text, replyTo, listenMinutes }) => {
    try {
      await sendMessage({ channel, conversation, text, replyTo });

      // Activate group watch window (fire-and-forget via Skill HTTP)
      const minutes = listenMinutes ?? 3;
      if (minutes > 0 && SKILL_ENDPOINT) {
        fetch(`${SKILL_ENDPOINT}/watch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation, minutes }),
        }).catch(() => {});
      }

      return { content: [{ type: "text" as const, text: `Message sent to ${channel}/${conversation}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to send: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "react_message",
  "Add or remove an emoji reaction on a message.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Platform message ID (msgId from notification header, NOT seq)"),
    emoji: z.string().describe("Emoji to react with"),
    remove: z.boolean().optional().describe("If true, removes the reaction"),
  },
  async ({ channel, conversation, messageId, emoji, remove }) => {
    try {
      await sendOutbound({ channel, conversation, skillEndpoint: "/react", payload: { conversation, messageId: Number(messageId), emoji, remove } });
      return { content: [{ type: "text" as const, text: `Reaction ${remove ? "removed" : "added"}: ${emoji}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "edit_message",
  "Edit a previously sent bot message.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Platform message ID"),
    text: z.string().describe("New text content"),
  },
  async ({ channel, conversation, messageId, text }) => {
    try {
      await sendMessage({ channel, conversation, text, editMessageId: messageId });
      return { content: [{ type: "text" as const, text: `Message ${messageId} edited` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "delete_message",
  "Delete a message. Can delete bot's own messages, or others in groups where bot is admin.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    messageId: z.string().describe("Platform message ID"),
  },
  async ({ channel, conversation, messageId }) => {
    try {
      await sendOutbound({ channel, conversation, skillEndpoint: "/delete", payload: { conversation, messageId: Number(messageId) } });
      return { content: [{ type: "text" as const, text: `Message ${messageId} deleted` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "send_sticker",
  "Send a Telegram sticker by fileId. Get fileId from get_sticker_set or chat log JSONL.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    fileId: z.string().describe("Sticker file_id"),
    replyTo: z.string().optional().describe("Message ID to reply to"),
  },
  async ({ channel, conversation, fileId, replyTo }) => {
    try {
      await sendOutbound({ channel, conversation, skillEndpoint: "/sticker", payload: { conversation, fileId, replyTo: replyTo ? Number(replyTo) : undefined } });
      return { content: [{ type: "text" as const, text: "Sticker sent" }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "get_sticker_set",
  "Browse a Telegram sticker set by name. Returns paginated stickers with thumbnails.",
  {
    name: z.string().describe("Sticker set name (e.g. 'HotCherry')"),
    offset: z.number().optional().describe("Start index (default 0)"),
    limit: z.number().optional().describe("Number of stickers (default 10, max 20)"),
  },
  async ({ name, offset, limit }) => {
    try {
      if (!SKILL_ENDPOINT) {
        return { content: [{ type: "text" as const, text: "Telegram skill endpoint not configured" }], isError: true };
      }

      const res = await fetch(`${SKILL_ENDPOINT}/sticker_set`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, offset, limit }),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text" as const, text: `Skill error ${res.status}: ${err}` }], isError: true };
      }

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
        blocks.push({ type: "text" as const, text: `#${s.index} file_id=${s.fileId} emoji=${s.emoji ?? "none"}${s.isAnimated ? " [animated]" : ""}${s.isVideo ? " [video]" : ""}` });
      }
      if (data.offset + data.count < data.total) {
        blocks.push({ type: "text" as const, text: `(${data.total - data.offset - data.count} more — use offset=${data.offset + data.count})` });
      }
      return { content: blocks };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
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
      const res = await sendOutbound({ channel, conversation, skillEndpoint: "/poll", payload: { conversation, question, options, isAnonymous, allowsMultiple } });
      const pollId = res?.pollId;
      return { content: [{ type: "text" as const, text: `Poll created${pollId ? ` (id: ${pollId})` : ""}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "get_message",
  "Fetch a specific message from chat history. Returns full content including images.",
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    date: z.string().describe("Date string (e.g. '2026-03-13')"),
    seq: z.number().optional().describe("Message seq number within that day's file"),
    platformMessageId: z.number().optional().describe("Platform-specific message ID (alternative to seq)"),
  },
  async ({ channel, conversation, date, seq, platformMessageId }) => {
    try {
      const data = await sendOutbound({
        channel, conversation,
        skillEndpoint: "/get_message",
        payload: { conversation, date, seq, messageId: platformMessageId },
      }) as { error?: string; message: Record<string, any>; attachments: { mimeType: string; data: string }[] };

      if (data.error) return { content: [{ type: "text" as const, text: `Not found: ${data.error}` }], isError: true };

      const blocks: any[] = [];
      const msg = data.message;
      const sender = msg.sender?.name ?? "Unknown";
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

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 2: 验证文件语法**

Run: `cd /Users/zhaoqixuan/Projects/CodeClaw && npx tsx --eval "import('./skills/telegram/mcp-server.ts')" 2>&1 | head -5`

注意：这不会真正启动（stdin 不是 JSON-RPC），但能验证导入和语法。

**Step 3: Commit**

```bash
git add skills/telegram/mcp-server.ts
git commit -m "feat(telegram): add stdio MCP server (8 tools, self-contained kernel client)"
```

---

### Task 2: 更新 manifest.json 添加 MCP 入口点

**Files:**
- Modify: `skills/telegram/manifest.json`

**Step 1: 添加 mcpEntrypoint 字段**

将 `manifest.json` 修改为：

```json
{
  "skillId": "telegram",
  "type": "channel",
  "entrypoint": "/codeclaw/skills/telegram/service.ts",
  "mcpEntrypoint": "/codeclaw/skills/telegram/mcp-server.ts",
  "capabilities": ["send_message", "receive_message"]
}
```

**Step 2: Commit**

```bash
git add skills/telegram/manifest.json
git commit -m "feat(telegram): add mcpEntrypoint to manifest"
```

---

### Task 3: 更新 index.ts 扫描 manifest 组装 mcpServers

**Files:**
- Modify: `packages/agent-runtime/src/index.ts`

**Step 1: 收集 MCP 配置并传递给 agent-loop**

在 `index.ts` 中，skill 启动循环之后、`startAgentLoop` 调用之前，组装 `mcpServers` 配置：

```typescript
// 在 "Start polling kernel for messages" 之前插入：

// Assemble MCP server configs from skill manifests (stdio transport)
const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};

if (existsSync(skillsDir)) {
  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink());

  for (const entry of entries) {
    const manifestPath = join(skillsDir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (!manifest.mcpEntrypoint) continue;

      const service = skillServiceManager.getEndpoint(manifest.skillId);
      mcpServers[manifest.skillId] = {
        command: extname(manifest.mcpEntrypoint) === ".ts" ? "tsx" : "node",
        args: [manifest.mcpEntrypoint],
        env: {
          KERNEL_URL: kernelUrl,
          ...(service ? { SKILL_ENDPOINT: service } : {}),
        },
      };
      logger.info({ skillId: manifest.skillId, mcpEntrypoint: manifest.mcpEntrypoint }, "Registered MCP server from manifest");
    } catch (err) {
      logger.error({ err, manifestPath }, "Failed to read mcpEntrypoint from manifest");
    }
  }
}
```

更新 `startAgentLoop` 调用添加 `mcpServers` 参数：

```typescript
await startAgentLoop({
  injector,
  kernelClient,
  agentId,
  workspacePath,
  skillServiceManager,
  mcpServers,
});
```

**Step 2: Commit**

```bash
git add packages/agent-runtime/src/index.ts
git commit -m "feat(runtime): scan manifests for mcpEntrypoint, assemble stdio MCP configs"
```

---

### Task 4: 重写 agent-loop.ts 使用 stdio MCP + 事件流 typing 控制

**Files:**
- Modify: `packages/agent-runtime/src/agent-loop.ts`

这是最大的改动。分多步执行。

**Step 1: 更新 startAgentLoop 签名和 imports**

在 `startAgentLoop` 的 opts 类型中添加 `mcpServers`：

```typescript
export async function startAgentLoop(opts: {
  injector: MessageInjector;
  kernelClient: KernelClient;
  agentId: string;
  workspacePath: string;
  skillServiceManager: SkillServiceManager;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}): Promise<void> {
```

删除顶部的 `import { ProgressTracker }` 和 `import` sdk-mcp-tools 相关行：

```typescript
// 删除这些行：
// import { ProgressTracker } from "./progress-tracker.js";
// let createSdkMcpToolsFn: typeof import("./sdk-mcp-tools.js").createSdkMcpTools;
// const toolsMod = await import("./sdk-mcp-tools.js");
// createSdkMcpToolsFn = toolsMod.createSdkMcpTools;
```

**Step 2: 重写 runSdkLoop 的 MCP 和 typing 部分**

删除 `createSdkMcpToolsFn` 调用及其所有回调（`wasSendMessageCalled`、`resetSendFlag`、`setConversationCallback`、`onMessageSent`、`onShowProgress`）。

删除 `ProgressTracker` 创建和所有 `progressTracker.*` 调用。

将 `mcpServers` 参数透传到 `runSdkLoop`，替换 SDK query options 中的 mcpServers：

```typescript
// 旧代码：
// mcpServers: { codeclaw: mcpServer },

// 新代码：
mcpServers: opts.mcpServers,
```

其中 `opts.mcpServers` 来自 `runSdkLoop` 的新参数。

**Step 3: typing 控制改为事件流检测**

在 `stream_event` 的 `content_block_start` 处理中添加 typing 停止逻辑：

```typescript
if (event?.type === "content_block_start" && !parentId) {
  const block = event.content_block;
  if (block?.type === "mcp_tool_use") {
    // Stop typing when agent calls a send-type tool
    const sendTools = new Set(["send_message", "send_sticker", "send_poll"]);
    if (sendTools.has(block.name)) {
      stopTyping();
    }
  }
}
```

**Step 4: 清理 result handler**

删除 `sentViaTool`/`resetSendFlag` 相关日志和逻辑。result handler 简化为：

```typescript
if (msg.subtype === "success") {
  cumulativeCost += msg.total_cost_usd ?? 0;
  sessionId = msg.session_id;
  logger.info(
    {
      sessionId: msg.session_id,
      cost: msg.total_cost_usd,
      turns: msg.num_turns,
      durationMs: msg.duration_ms,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
    },
    "SDK: turn completed",
  );
}
```

**Step 5: 类型检查**

Run: `cd packages/agent-runtime && npx tsc --noEmit`
Expected: 无错误

**Step 6: Commit**

```bash
git add packages/agent-runtime/src/agent-loop.ts
git commit -m "refactor(runtime): replace in-process MCP with stdio configs, event-stream typing control"
```

---

### Task 5: 更新 progress-tracker.ts 的 HIDDEN_TOOLS

**Files:**
- Modify: `packages/agent-runtime/src/progress-tracker.ts`

**Step 1: 更新工具名前缀**

```typescript
// 旧：
const HIDDEN_TOOLS = new Set([
  "mcp__codeclaw__send_message",
  "mcp__codeclaw__skip_reply",
  "mcp__codeclaw__send_sticker",
  "mcp__codeclaw__send_poll",
]);

// 新：
const HIDDEN_TOOLS = new Set([
  "mcp__telegram__send_message",
  "mcp__telegram__send_sticker",
  "mcp__telegram__send_poll",
]);
```

同时删除 `activated` 字段和 `activate()` 方法（show_progress 暂不实现）。恢复为原始的始终激活行为：删除 `scheduleEdit()` 中的 `if (!this.activated) return;` 检查。

注意：ProgressTracker 暂时保留代码但不启用（agent-loop 不再创建它）。如果之后 show_progress 需要，可以重新接入。

**Step 2: Commit**

```bash
git add packages/agent-runtime/src/progress-tracker.ts
git commit -m "refactor(progress): update tool name prefix to mcp__telegram__, remove activated flag"
```

---

### Task 6: 删除 sdk-mcp-tools.ts

**Files:**
- Delete: `packages/agent-runtime/src/sdk-mcp-tools.ts`

**Step 1: 删除文件**

```bash
git rm packages/agent-runtime/src/sdk-mcp-tools.ts
```

**Step 2: 确认无残留引用**

Run: `grep -r "sdk-mcp-tools" packages/agent-runtime/src/`
Expected: 无输出

**Step 3: 类型检查**

Run: `cd packages/agent-runtime && npx tsc --noEmit`
Expected: 无错误

**Step 4: Commit**

```bash
git commit -m "refactor(runtime): delete sdk-mcp-tools.ts, tools moved to skills/telegram/mcp-server.ts"
```

---

### Task 7: 更新 SKILL.md

**Files:**
- Modify: `skills/telegram/SKILL.md`

**Step 1: 更新 frontmatter 和工具列表**

```yaml
---
name: telegram
description: "Telegram channel: send/receive messages, reactions, stickers, polls. Use when handling Telegram conversations or querying chat history."
---
```

Body 的 MCP Tools 部分更新为：

```markdown
## MCP Tools

Tools are provided by the `telegram` MCP server (prefix: `mcp__telegram__`).

### Messaging

- `send_message` — Send text reply. Set `channel: "telegram"`, `conversation: "<chatId>"`.
- `edit_message` — Edit a previously sent bot message by `messageId`.
- `delete_message` — Delete a message (own messages, or others if bot is admin).

### Reactions

- `react_message` — Add/remove emoji reaction on a message. Supports standard Unicode emoji.

### Stickers

- `get_sticker_set` — Browse a sticker set with visual thumbnails. Returns paginated results.
- `send_sticker` — Send a sticker by `fileId` (get from `get_sticker_set`).

### Polls

- `send_poll` — Create a poll with 2-10 options.

### History

- `get_message` — Fetch a specific historical message by `date` + `seq` or `platformMessageId`.
```

Group Chat Behavior 部分删除 `skip_reply` 引用，改为：

```markdown
## Group Chat Behavior

- You only receive messages that @mention you or reply to your messages.
- Other messages are stored in the JSONL log but not forwarded.
- Use `get_message` or grep the JSONL for prior context when needed.
- If a group message doesn't need a response, simply do nothing — no tool call required.
```

**Step 2: Commit**

```bash
git add skills/telegram/SKILL.md
git commit -m "docs(telegram): update SKILL.md for stdio MCP, remove skip_reply/show_progress"
```

---

### Task 8: 添加 @modelcontextprotocol/sdk 为 skills/telegram 依赖

**Files:**
- Modify: 根据 monorepo 结构，可能需要在 `packages/agent-runtime/package.json` 中保留（Dockerfile 会安装），或者在 Skill 级别管理。

**Step 1: 确认 @modelcontextprotocol/sdk 已在 agent-runtime 依赖中**

检查 `packages/agent-runtime/package.json` — 已有 `"@modelcontextprotocol/sdk": "^1.8.0"`。由于 Dockerfile 将整个仓库 COPY 并 `pnpm install`，skill 的 mcp-server.ts 通过 `tsx` 运行时可以解析到 agent-runtime 的 node_modules。无需额外操作。

**Step 2: 验证容器内路径**

Run: `DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock docker run --rm codeclaw/agent-runtime:dev ls /codeclaw/node_modules/@modelcontextprotocol/sdk/server/ 2>/dev/null | head`
Expected: 包含 `mcp.js`、`stdio.js` 等文件

如果路径不对，需要调整 Dockerfile 的 `pnpm install` 或加 `--shamefully-hoist`。

---

### Task 9: 构建 Docker 镜像并验证

**Files:** 无新文件

**Step 1: 构建镜像**

```bash
cd /Users/zhaoqixuan/Projects/CodeClaw
DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock \
  docker build -t codeclaw/agent-runtime:dev -f packages/agent-runtime/Dockerfile.dev .
```

**Step 2: 部署**

```bash
./scripts/deploy.sh --build
```

**Step 3: 验证日志**

```bash
DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock docker logs --tail 30 codeclaw-agent-andy
```

Expected:
- `Agent mode detected: sdk`
- `Registered MCP server from manifest` (skillId: telegram)
- MCP 连接成功：`mcpServers: [{ name: "telegram", status: "connected" }]`

**Step 4: 发送 Telegram 消息验证端到端**

发一条消息，确认 agent 能调用 `mcp__telegram__send_message` 回复。

**Step 5: Commit（如果有修正）**

```bash
git add -A
git commit -m "fix: deployment adjustments for stdio MCP"
```

---

### Task 10: 更新文档

**Files:**
- Modify: `docs/design.md`

**Step 1: 更新模块职责描述**

- `sdk-mcp-tools.ts` 描述改为 `mcp-server.ts` 在 `skills/telegram/` 下
- 更新工具数量（10 → 8）和命名前缀（`mcp__codeclaw__` → `mcp__telegram__`）
- 更新 Telegram Skill HTTP API 表格（如有引用）
- 添加 MCP 架构说明：stdio 子进程，遵循 Plugin 标准

**Step 2: Commit**

```bash
git add docs/design.md
git commit -m "docs: update design.md for stdio MCP architecture"
```
