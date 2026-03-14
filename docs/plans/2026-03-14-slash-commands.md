# Slash Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 三层斜杠命令系统 — Skill 层拦截、Agent Runtime 层路由、SDK 层透传

**Architecture:** 用户在 Telegram 输入 `/xxx`，Telegram Skill 检测 `/` 前缀后决定拦截或转发。Skill 层处理 `/status` `/help`（即时响应，不过 Agent）。Agent Runtime 层拦截 `/model` `/interrupt` `/cost`（调 Query 控制方法）。其余命令作为纯文本 push 进 SDK MessageStream（SDK 内置处理 `/compact` `/review` 等）。

**Tech Stack:** TypeScript, Grammy (Telegram), Claude Agent SDK `Query` 接口

---

## 背景信息

### 当前消息流
```
Telegram → service.ts bot.on("message")
  → 构建 notification header + content
  → forwardToKernel() POST /api/messages/inbound
  → Kernel MessageQueue → Agent Runtime polls
  → MessageInjector.waitForMessage() → agent-loop.ts
  → formatMessageForAgent() → SDK MessageStream
```

### SDK Query 控制方法（已确认可用）
- `q.setModel(model?)` — 切换模型
- `q.interrupt()` — 中断当前执行
- `q.supportedCommands()` — 列出可用命令

### SDK 内置斜杠命令（已确认可用）
`/compact` `/cost` `/context` `/debug` `/review` `/security-review` `/simplify` `/batch` `/loop` `/pr-comments` `/release-notes` `/insights` `/init`

### 关键文件
- `packages/types/src/messages.ts` — InboundMessage 类型定义
- `skills/telegram/service.ts` — Telegram Skill，bot 消息处理 + HTTP endpoints
- `packages/agent-runtime/src/agent-loop.ts` — SDK 模式 agent loop，MessageStream
- `packages/kernel/src/http-server.ts` — Kernel HTTP 服务器（透传 InboundMessage）

---

## Task 1: InboundMessage 添加 metadata 字段

**Files:**
- Modify: `packages/types/src/messages.ts:11-27`

**Step 1: 添加 optional metadata 字段**

在 `InboundMessage` interface 末尾添加:

```typescript
export interface InboundMessage {
  id: string;
  channel: string;
  sender: {
    id: string;
    name: string;
    channel: string;
  };
  conversation: {
    id: string;
    type: "group" | "dm";
    title?: string;
  };
  content: MessageContent;
  timestamp: number;
  replyTo?: string;
  /** Optional metadata for cross-layer communication (e.g. command routing). */
  metadata?: Record<string, unknown>;
}
```

Kernel 的 `http-server.ts` 和 `message-queue.ts` 都使用 `as InboundMessage` 类型断言，额外字段自动透传，无需改动。

**Step 2: 验证编译**

Run: `cd /Users/zhaoqixuan/Projects/CodeClaw && npx tsc --noEmit -p packages/types/tsconfig.json`
Expected: 无错误

---

## Task 2: Telegram Skill — 命令检测与 Skill 层拦截

**Files:**
- Modify: `skills/telegram/service.ts`

**Step 1: 在 `bot.on("message")` handler 的文本处理分支中添加命令检测**

在 `service.ts` 的 `if (msg.text != null)` 分支开头（line ~370），在 `@mention` 去除之后、构建 notification header 之前，插入命令检测:

```typescript
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
      if (cmd === "/status" || cmd === "/help") {
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

    // --- Normal text message handling (existing code continues) ---
```

注意：命令消息不经过群聊 `isDirectlyAddressed` 过滤（命令本身就是显式意图），所以命令检测必须在群聊过滤（line ~472）之前。因为我们在 `if (msg.text != null)` 分支内部提前 return 了，所以自然绕过了后面的群聊过滤。

**Step 2: 实现 handleSkillCommand 函数**

在 `main()` 函数内、`bot.on("message")` 之前定义:

```typescript
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
```

**Step 3: 验证语法**

Run: `cd /Users/zhaoqixuan/Projects/CodeClaw && npx tsc --noEmit -p skills/telegram/tsconfig.json 2>&1 || echo "Check errors"`

如果 `skills/telegram/` 没有独立 tsconfig，用: `npx tsx --eval "import './skills/telegram/service.ts'" 2>&1 | head -5` 验证能否解析（不要实际运行，只检查语法）。

---

## Task 3: Agent Runtime — 命令路由

**Files:**
- Modify: `packages/agent-runtime/src/agent-loop.ts`

### Step 1: 添加命令路由函数

在 `runSdkLoop` 函数内部，`pumpMessages` 之前，添加命令处理函数:

```typescript
/** Handle a slash command at the Runtime level. Returns true if handled (don't push to stream). */
async function handleRuntimeCommand(msg: InboundMessage): Promise<boolean> {
    const meta = (msg as any).metadata as { command?: string; args?: string; raw?: string } | undefined;
    if (!meta?.command) return false;

    const cmd = meta.command;
    const args = meta.args ?? "";

    if (cmd === "/model") {
      if (!args) {
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: `Current model: ${model}` },
          replyTo: msg.id,
        }).catch(() => {});
        return true;
      }
      try {
        await q.setModel(args);
        logger.info({ newModel: args }, "SDK: model changed via /model command");
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: `Model switched to: ${args}` },
          replyTo: msg.id,
        }).catch(() => {});
      } catch (err) {
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}` },
          replyTo: msg.id,
        }).catch(() => {});
      }
      return true;
    }

    if (cmd === "/interrupt") {
      try {
        await q.interrupt();
        logger.info("SDK: interrupted via /interrupt command");
        await kernelClient.sendMessage({
          channel: msg.channel, conversation: msg.conversation.id,
          content: { type: "text", text: "Interrupted." },
          replyTo: msg.id,
        }).catch(() => {});
      } catch (err) {
        logger.error({ err }, "SDK: /interrupt failed");
      }
      return true;
    }

    if (cmd === "/cost") {
      // cumulativeCost is tracked from result messages
      await kernelClient.sendMessage({
        channel: msg.channel, conversation: msg.conversation.id,
        content: { type: "text", text: `Session cost: $${cumulativeCost.toFixed(4)}` },
        replyTo: msg.id,
      }).catch(() => {});
      return true;
    }

    // Not a runtime command — let it pass through to SDK
    return false;
  }
```

### Step 2: 添加 cumulativeCost 变量

在 `runSdkLoop` 函数开头（`let lastMessage` 附近）添加:

```typescript
let cumulativeCost = 0;
```

在 `result/success` handler 中累加:

```typescript
if (msg.subtype === "success") {
    cumulativeCost += msg.total_cost_usd ?? 0;
    // ... existing code
```

### Step 3: 修改 pumpMessages 和 firstMessage 处理

对 **firstMessage** 处理（在 `stream.push(firstFormatted, sessionId)` 之前）:

```typescript
const firstMsg = await injector.waitForMessage();
lastMessage = firstMsg;

// Check if first message is a command
if (await handleRuntimeCommand(firstMsg)) {
    // Command handled, wait for next real message
    // Re-enter the wait loop via pumpMessages (will be started below)
} else {
    const firstFormatted = await formatMessageForAgent(firstMsg);
    logger.info({ formatted: firstFormatted }, "SDK: received first message");
    await kernelClient.reportHealth(agentId, "busy").catch(() => {});
    startTyping();
    stream.push(firstFormatted, sessionId);
    resetSendFlag();
}
```

注意：如果第一条消息就是命令，我们需要继续等待下一条非命令消息再启动 SDK query。改为循环:

```typescript
// Wait for the first non-command message before starting the SDK query
let firstMsg: InboundMessage;
while (true) {
    firstMsg = await injector.waitForMessage();
    lastMessage = firstMsg;
    if (await handleRuntimeCommand(firstMsg)) continue;
    break;
}
const firstFormatted = await formatMessageForAgent(firstMsg);
// ... rest unchanged
```

对 **pumpMessages** 中的消息处理:

```typescript
const pumpMessages = async () => {
    while (true) {
      try {
        const msg = await injector.waitForMessage();
        lastMessage = msg;

        // Check for runtime commands
        if (await handleRuntimeCommand(msg)) continue;

        // Check for SDK commands — push raw command text, not notification header
        const meta = (msg as any).metadata as { command?: string; raw?: string } | undefined;
        if (meta?.command) {
          // SDK command: push just the command text (e.g. "/compact")
          logger.info({ command: meta.raw }, "SDK: forwarding command to SDK");
          resetSendFlag();
          stream.push(meta.raw ?? meta.command, sessionId);
          continue;
        }

        // Normal message
        const formatted = await formatMessageForAgent(msg);
        logger.info({ formatted: typeof formatted === "string" ? formatted : "[multimodal]" }, "SDK: injecting message");
        resetSendFlag();
        stream.push(formatted, sessionId);
        await kernelClient.reportHealth(agentId, "busy").catch(() => {});
        startTyping();
      } catch (err) {
        logger.error({ err }, "SDK: message pump error");
        break;
      }
    }
  };
```

### Step 4: 移除 supportedCommands 探测代码

在 `system/init` handler 中，删除之前添加的探测代码:

```typescript
// 删除这段:
q.supportedCommands().then((cmds) => {
    logger.info({ commands: cmds }, "SDK: supported commands");
}).catch(() => {});
```

---

## Task 4: 构建验证

**Step 1: TypeScript 编译检查**

Run: `cd /Users/zhaoqixuan/Projects/CodeClaw && npx tsc --noEmit`
Expected: 无编译错误

**Step 2: 构建 Docker 镜像**

Run:
```bash
DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock \
  docker build -t codeclaw/agent-runtime:dev -f packages/agent-runtime/Dockerfile.dev .
```
Expected: Successfully built

**Step 3: 部署并测试**

```bash
DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock docker stop codeclaw-agent-andy 2>/dev/null
DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock docker rm codeclaw-agent-andy 2>/dev/null
DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock \
  docker run -d --name codeclaw-agent-andy \
  -v $(pwd)/.agent-home:/home/codeclaw \
  -p 7001:7001 \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID=andy \
  -e ANTHROPIC_API_KEY="sk-proxy-f45aba0afc4a9aee3437e02960b7093e" \
  -e ANTHROPIC_BASE_URL="https://proxy.moedb.moe" \
  -e CLAUDE_MODEL="aws-claude-opus-4-6" \
  -e HTTP_PROXY="http://host.docker.internal:7890" \
  -e HTTPS_PROXY="http://host.docker.internal:7890" \
  -e https_proxy="http://host.docker.internal:7890" \
  -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  codeclaw/agent-runtime:dev
```

**Step 4: 功能测试**

在 Telegram 中发送以下命令，验证行为:

| 测试 | 输入 | 预期 |
|------|------|------|
| Skill 层 | `/status` | 立即回复 Kernel uptime/queue/skills，不触发 Agent |
| Skill 层 | `/help` | 立即回复命令列表 |
| Runtime 层 | `/cost` | 回复 session 累计费用 |
| Runtime 层 | `/model` | 回复当前模型名 |
| SDK 层 | `/compact` | Agent 执行 context compaction（日志可见 `compact_boundary`）|
| 普通消息 | `你好` | 正常 Agent 回复 |

**Step 5: 提交**

```bash
git add packages/types/src/messages.ts skills/telegram/service.ts packages/agent-runtime/src/agent-loop.ts
git commit -m "feat: three-layer slash command system (/status, /help, /model, /interrupt, /cost, SDK pass-through)

- types: add optional metadata field to InboundMessage
- telegram skill: detect / prefix, handle /status and /help locally
- agent-loop: route /model /interrupt /cost via Query methods, forward SDK commands as raw text
- track cumulative cost from SDK result messages

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
