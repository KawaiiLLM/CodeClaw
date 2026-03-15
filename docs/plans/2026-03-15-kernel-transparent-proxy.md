# Kernel 透明代理重构 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Kernel IOBridge 成为纯粹的消息路由器，移除所有 channel 特定逻辑，同时清理审计发现的中等严重度问题。

**Architecture:** 当前 Kernel 的 `routeOutbound()` 在 outbound 路径上做了三件不该做的事：`Number()` 类型转换、`/edit` vs `/send` 路由决策、`content.type` 业务校验。重构后 Kernel 统一将完整 `OutboundMessage` 透传给 Skill 的 `/send` 端点，Skill 自行决定如何处理。同时修正 system prompt、config 默认值和 types 注释中的 channel 特定引用。

**Tech Stack:** TypeScript, Node.js raw HTTP, @modelcontextprotocol/sdk

---

### Task 1: IOBridge `routeOutbound()` 透传重构

**Files:**
- Modify: `packages/kernel/src/io-bridge.ts:104-117`

**Step 1: 重写标准消息路由路径**

将当前的 edit/send 分支逻辑：

```typescript
// 删除这段（第 104-117 行）:
const route = msg.editMessageId ? "/edit" : "/send";
const url = `${service.endpoint}${route}`;
logger.debug({ channel: msg.channel, conversation: msg.conversation, endpoint: url, route }, "Routing outbound message");

let payload: unknown;
if (msg.editMessageId) {
  if (msg.content.type !== "text") {
    throw new Error("editMessageId is only supported for text content");
  }
  payload = { conversation: msg.conversation, messageId: Number(msg.editMessageId), text: msg.content.text };
} else {
  payload = msg;
}
```

替换为透传逻辑：

```typescript
const url = `${service.endpoint}/send`;
logger.debug({ channel: msg.channel, conversation: msg.conversation, endpoint: url }, "Routing outbound message");
const payload = msg;
```

**Step 2: 验证构建通过**

Run: `cd packages/kernel && npx tsc --noEmit`
Expected: 无错误

**Step 3: Commit**

```bash
git add packages/kernel/src/io-bridge.ts
git commit -m "refactor(kernel): IOBridge routeOutbound transparent pass-through

Remove channel-specific logic from Kernel:
- Remove Number() conversion of editMessageId
- Remove /edit vs /send routing decision
- Remove content.type assertion
Kernel now always forwards full OutboundMessage to Skill /send."
```

---

### Task 2: Telegram Skill `/send` 端点统一处理 edit

**Files:**
- Modify: `skills/telegram/service.ts:634-694`

**Step 1: 扩展 `/send` handler 支持 editMessageId**

当前 `/send` handler（第 634-679 行）只处理发送。改为也处理编辑：

```typescript
if (req.method === "POST" && req.url === "/send") {
  try {
    const body = await parseBody(req);
    const { conversation, content, replyTo, editMessageId, progress } = body as {
      conversation: string;
      content: { type: string; text: string };
      replyTo?: string;
      editMessageId?: string;
      progress?: boolean;
    };

    // Edit path: editMessageId present
    if (editMessageId && content.type === "text") {
      const msgId = parseInt(editMessageId, 10);
      if (isNaN(msgId)) {
        sendJson(res, 400, { error: "Invalid editMessageId" });
        return;
      }
      await bot.api.editMessageText(conversation, msgId, content.text);
      sendJson(res, 200, { success: true });
      return;
    }

    // Send path (existing logic unchanged)
    if (content.type === "text") {
      let replyMsgId: number | undefined;
      if (replyTo) {
        const idPart = replyTo.startsWith("tg_") ? replyTo.split("_").pop() : replyTo;
        const parsed = idPart ? parseInt(idPart, 10) : NaN;
        if (!isNaN(parsed)) replyMsgId = parsed;
      }

      const sent = await bot.api.sendMessage(conversation, content.text, {
        ...(replyMsgId ? { reply_parameters: { message_id: replyMsgId } } : {}),
      });

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
    console.error("[telegram] Failed to handle outbound message:", err);
    sendJson(res, 500, { error: String(err) });
  }
}
```

**Step 2: 删除独立的 `/edit` 端点**

删除第 681-694 行的 `/edit` handler（现已由 `/send` 统一处理）：

```typescript
// 删除整个 } else if (req.method === "POST" && req.url === "/edit") { ... } 块
```

**Step 3: 验证构建**

Run: `cd skills/telegram && npx tsc --noEmit`
Expected: 无错误

**Step 4: Commit**

```bash
git add skills/telegram/service.ts
git commit -m "refactor(telegram): unify /send endpoint to handle edit

/send now accepts editMessageId field and handles edit internally.
Removes /edit endpoint (Kernel no longer routes to it).
Edit logic (Number conversion, text-only check) now lives in Skill."
```

---

### Task 3: 清理 system prompt 中的 channel 特定引用

**Files:**
- Modify: `packages/agent-runtime/src/agent-loop.ts:96,642`

**Step 1: 修改 SDK 模式 system prompt**

第 96 行，将：
```
You receive messages from various channels (Telegram, web, etc.) via a message queue.
```
改为：
```
You receive messages from various channels via a message queue.
```

**Step 2: 修改 Chat 模式 system prompt**

第 642 行，将：
```
You receive messages from various channels (Telegram, web, etc.) via a message queue.
```
改为：
```
You receive messages from various channels via a message queue.
```

**Step 3: Commit**

```bash
git add packages/agent-runtime/src/agent-loop.ts
git commit -m "refactor(agent-loop): remove channel-specific mentions from system prompt"
```

---

### Task 4: 清理 types 注释和 config 默认值

**Files:**
- Modify: `packages/types/src/messages.ts:13`
- Modify: `packages/kernel/src/config.ts:30,56,58,68,70`

**Step 1: types 注释 channel-agnostic 化**

`packages/types/src/messages.ts` 第 13 行，将：
```typescript
channel: string; // "telegram", "web", "cli"
```
改为：
```typescript
channel: string;
```

**Step 2: config 默认 agent ID 中性化**

`packages/kernel/src/config.ts`，将所有 `"andy"` 默认值改为 `"agent-0"`：

- 第 30 行: `id: "andy"` → `id: "agent-0"`
- 第 32 行: `volume: "codeclaw-andy-home"` → `volume: "codeclaw-agent-0-home"`
- 第 56 行: `(a.id as string) ?? "andy"` → `(a.id as string) ?? "agent-0"`
- 第 58 行: `` `codeclaw-${a.id ?? "andy"}-home` `` → `` `codeclaw-${a.id ?? "agent-0"}-home` ``
- 第 68 行: `(agent?.id as string) ?? "andy"` → `(agent?.id as string) ?? "agent-0"`
- 第 70 行: `"codeclaw-andy-home"` → `"codeclaw-agent-0-home"`

**Step 3: Commit**

```bash
git add packages/types/src/messages.ts packages/kernel/src/config.ts
git commit -m "refactor: channel-agnostic type comments, neutral default agent ID"
```

---

### Task 5: 构建部署验证

**Step 1: 构建 Docker 镜像**

```bash
DOCKER_HOST="unix:///Users/zhaoqixuan/.colima/default/docker.sock" \
docker build -t codeclaw/agent-runtime:dev -f packages/agent-runtime/Dockerfile.dev .
```

**Step 2: 部署 sakiko**

```bash
DOCKER_HOST="unix:///Users/zhaoqixuan/.colima/default/docker.sock" \
DEPLOY_VOLUME=codeclaw-andy-home bash scripts/deploy.sh sakiko
```

**Step 3: 部署 anon**

```bash
DOCKER_HOST="unix:///Users/zhaoqixuan/.colima/default/docker.sock" \
DEPLOY_PORT=7002 bash scripts/deploy.sh anon
```

**Step 4: 验证 Kernel 注册和 MCP 连接**

```bash
# Kernel 服务注册
curl -s http://localhost:19000/api/status | python3 -m json.tool | head -20

# sakiko 日志：确认 3 个 MCP server 连接
docker logs codeclaw-agent-sakiko 2>&1 | grep -i "mcp\|core\|connected" | tail -10
```

Expected:
- `sakiko:telegram` 和 `anon:telegram` 均注册
- 日志中出现 core + searxng + telegram 三个 MCP server

**Step 5: 功能验证**

发送 Telegram 消息测试：
1. 普通发送：发消息给 sakiko → 应正常收到回复
2. Edit 测试：agent 调用 `show_progress` → 应正常创建/编辑/删除 progress 消息
3. Inter-agent 测试：sakiko 调用 `send_to_agent(targetAgent: "anon", message: "ping")` → anon 应正常收到

**Step 6: Commit (如果需要修复)**

```bash
git commit -m "fix: address issues found during deployment verification"
```
