# Progress/Typing 两层反馈重构 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 agent-loop 中硬编码的 Telegram typing/progress 逻辑重构为 channel-agnostic 的两层反馈模型：Layer 1 (typing) 由 MCP server 自动轮询 Kernel health 驱动，Layer 2 (progress) 由 Agent 主动调用 `show_progress` 工具驱动。

**Architecture:** agent-loop 不再知道 typing/progress 概念，只上报 `busy`/`idle` 健康状态到 Kernel。MCP server 轮询 Kernel 获取 agent 状态，自动发送 typing；Agent 在长程任务中主动调用 `show_progress` 工具展示/更新/关闭进度消息，进度消息激活时替代 typing 避免频率限制。

**Tech Stack:** TypeScript ESM, `@modelcontextprotocol/sdk`, Kernel raw HTTP, grammy (间接通过 SKILL_ENDPOINT)

---

### Task 1: Kernel — 添加 `GET /api/agent/health` 端点

**Files:**
- Modify: `packages/kernel/src/http-server.ts:85-111`

**Step 1: 添加 GET 路由**

在 `routes.GET` 对象中添加 `/api/agent/health` 端点：

```typescript
      "/api/agent/health": async () => {
        // Return health for the default agent (single-agent system)
        const agents = supervisor.getAllHealth();
        return agents;
      },
```

**Step 2: 在 AgentSupervisor 中添加 `getAllHealth()` 方法**

Modify: `packages/kernel/src/agent-supervisor.ts:82-89`

在现有 `getHealth()` 方法后添加：

```typescript
  /** Get health states for all monitored agents. */
  getAllHealth(): Record<string, { status: string; lastReportAt: number }> {
    const result: Record<string, { status: string; lastReportAt: number }> = {};
    for (const [agentId, state] of this.agents) {
      result[agentId] = {
        status: state.lastHealth?.status ?? "unknown",
        lastReportAt: state.lastHealthAt,
      };
    }
    return result;
  }
```

**Step 3: 验证**

Run: `npx tsc --noEmit -p packages/kernel/tsconfig.json`
Expected: 无错误

**Step 4: Commit**

```bash
git add packages/kernel/src/http-server.ts packages/kernel/src/agent-supervisor.ts
git commit -m "feat(kernel): add GET /api/agent/health endpoint for MCP server polling"
```

---

### Task 2: MCP server — 添加 typing 自动轮询 (Layer 1)

**Files:**
- Modify: `skills/telegram/mcp-server.ts:1-22` (顶部 imports 和 helpers)
- Modify: `skills/telegram/mcp-server.ts:285-289` (底部 start 区域)

**Step 1: 添加 health 轮询和 typing 逻辑**

在 `mcp-server.ts` 底部 `// --- Start ---` 之前，添加 typing 轮询：

```typescript
// --- Typing auto-poll (Layer 1) ---

const TYPING_POLL_MS = 5000;
const AGENT_ID = process.env.AGENT_ID ?? "andy";

/** Track active progress message — when set, skip typing (Layer 2 replaces Layer 1) */
let progressMsgId: number | null = null;
let progressConv: string | null = null;

async function getAgentStatus(): Promise<string> {
  try {
    const res = await fetch(`${KERNEL_URL}/api/agent/health`);
    if (!res.ok) return "unknown";
    const data = await res.json() as Record<string, { status: string }>;
    return data[AGENT_ID]?.status ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function sendTyping(conversation: string): Promise<void> {
  if (!SKILL_ENDPOINT) return;
  fetch(`${SKILL_ENDPOINT}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation, action: "typing" }),
  }).catch(() => {});
}

/** Last conversation that sent a message to the agent (for typing target) */
let lastConversation: string | null = null;

setInterval(async () => {
  if (!lastConversation) return;
  // Layer 2 active → skip typing (progress message already indicates activity)
  if (progressMsgId) return;

  const status = await getAgentStatus();
  if (status === "busy") {
    await sendTyping(lastConversation);
  }
}, TYPING_POLL_MS);
```

**Step 2: 更新 `send_message` 工具以跟踪 lastConversation**

在 `send_message` 工具的 handler 开头添加一行：

```typescript
  async ({ channel, conversation, text, replyTo, listenMinutes }) => {
    lastConversation = conversation;  // Track for typing target
    try {
```

注意：`lastConversation` 在这里是用于 typing 的目标 conversation。每次 agent 发消息时更新，因为发消息意味着这是当前活跃的会话。但 typing 主要在 agent **接收**消息后触发，所以我们还需要在处理 inbound 消息时设置它。

实际上，MCP server 不直接接收 inbound 消息。`lastConversation` 应该从 `show_progress` 工具调用中获取，或者从 Kernel health endpoint 返回的数据中获取。

更好的方案：扩展 Kernel health 返回值，包含当前正在处理的 conversation。

**Step 2 (修正): 在 agent-loop 的 reportHealth 中附带 conversation 信息**

Modify: `packages/agent-runtime/src/agent-loop.ts`

找到 `await kernelClient.reportHealth(agentId, "busy")` 的调用（有多处），添加 conversation 信息：

```typescript
await kernelClient.reportHealth(agentId, "busy", {
  sessionId,
  conversation: lastMessage ? `${lastMessage.channel}/${lastMessage.conversation.id}` : undefined,
}).catch(() => {});
```

Modify: `packages/types/src/kernel-api.ts:26-31`

在 `AgentHealthReport` 接口中添加 `conversation` 字段：

```typescript
export interface AgentHealthReport {
  agentId: string;
  status: "alive" | "busy" | "idle";
  timestamp: number;
  sessionId?: string;
  lastAssistantMessageId?: string;
  conversation?: string;  // "channel/conversationId" of currently active message
}
```

Modify: `packages/kernel/src/agent-supervisor.ts`

在 `getHealth()` 和 `getAllHealth()` 返回值中添加 `conversation`：

```typescript
  getHealth(agentId: string): { status: string; lastReportAt: number; conversation?: string } | null {
    const state = this.agents.get(agentId);
    if (!state) return null;
    return {
      status: state.lastHealth?.status ?? "unknown",
      lastReportAt: state.lastHealthAt,
      conversation: state.lastHealth?.conversation,
    };
  }

  getAllHealth(): Record<string, { status: string; lastReportAt: number; conversation?: string }> {
    const result: Record<string, { status: string; lastReportAt: number; conversation?: string }> = {};
    for (const [agentId, state] of this.agents) {
      result[agentId] = {
        status: state.lastHealth?.status ?? "unknown",
        lastReportAt: state.lastHealthAt,
        conversation: state.lastHealth?.conversation,
      };
    }
    return result;
  }
```

然后 MCP server 的 typing 轮询改为从 health 数据获取 conversation：

```typescript
setInterval(async () => {
  if (progressMsgId) return;  // Layer 2 active, skip typing

  try {
    const res = await fetch(`${KERNEL_URL}/api/agent/health`);
    if (!res.ok) return;
    const data = await res.json() as Record<string, { status: string; conversation?: string }>;
    const agent = data[AGENT_ID];
    if (!agent || agent.status !== "busy" || !agent.conversation) return;

    // conversation format: "telegram/5767700706"
    const [channel, convId] = agent.conversation.split("/", 2);
    if (channel !== "telegram" || !convId) return;

    await sendTyping(convId);
  } catch {
    // Kernel unreachable, silently skip
  }
}, TYPING_POLL_MS);
```

**Step 3: 验证**

Run: `npx tsc --noEmit -p packages/types/tsconfig.json && npx tsc --noEmit -p packages/kernel/tsconfig.json`
Expected: 无错误

**Step 4: Commit**

```bash
git add packages/types/src/kernel-api.ts packages/kernel/src/agent-supervisor.ts packages/kernel/src/http-server.ts skills/telegram/mcp-server.ts
git commit -m "feat: Layer 1 typing — MCP server polls Kernel health, auto-sends typing"
```

---

### Task 3: MCP server — 添加 `show_progress` 工具 (Layer 2)

**Files:**
- Modify: `skills/telegram/mcp-server.ts` (在 `get_message` 工具之后添加)

**Step 1: 添加 show_progress 工具**

```typescript
server.tool(
  "show_progress",
  `Toggle a progress status message in the conversation. Use ONLY for long-running tasks (multi-step file analysis, complex searches, etc.) — not for quick replies.

When active=true: creates or updates a visible status message and suppresses the automatic typing indicator.
When active=false: deletes the status message and resumes automatic typing.

Typical flow:
1. show_progress(active: true, status: "📖 Reading chat history...")
2. ...do work (Read, Grep, Bash, etc.)...
3. show_progress(active: true, status: "🔍 Analyzing results...")
4. ...more work...
5. When ready to reply, call show_progress(active: false) in PARALLEL with send_message.`,
  {
    channel: z.string().describe("Target channel"),
    conversation: z.string().describe("Conversation/chat ID"),
    active: z.boolean().describe("true to show/update progress, false to dismiss"),
    status: z.string().optional().describe("Status text (required when active=true)"),
  },
  async ({ channel, conversation, active, status }) => {
    try {
      if (active) {
        if (!status) {
          return { content: [{ type: "text" as const, text: "status is required when active=true" }], isError: true };
        }
        if (progressMsgId && progressConv === conversation) {
          // Edit existing progress message
          await kernelPost("/api/messages/outbound", {
            channel,
            conversation,
            content: { type: "text", text: status },
            editMessageId: String(progressMsgId),
          });
        } else {
          // Clean up old progress message if switching conversation
          if (progressMsgId && progressConv) {
            sendOutbound({ channel, conversation: progressConv, skillEndpoint: "/delete", payload: { conversation: progressConv, messageId: progressMsgId } }).catch(() => {});
          }
          // Send new progress message (progress: true skips JSONL)
          const res = await kernelPost("/api/messages/outbound", {
            channel,
            conversation,
            content: { type: "text", text: status },
            progress: true,
          });
          progressMsgId = res?.messageId ? Number(res.messageId) : null;
          progressConv = conversation;
        }
        return { content: [{ type: "text" as const, text: "Progress shown" }] };
      } else {
        // Dismiss progress message
        if (progressMsgId && progressConv) {
          await sendOutbound({ channel, conversation: progressConv, skillEndpoint: "/delete", payload: { conversation: progressConv, messageId: progressMsgId } }).catch(() => {});
          progressMsgId = null;
          progressConv = null;
        }
        return { content: [{ type: "text" as const, text: "Progress dismissed" }] };
      }
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);
```

**Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit -p skills/telegram/tsconfig.json` (若无 tsconfig，则 `npx tsx --eval "import('./skills/telegram/mcp-server.ts')"`)

**Step 3: Commit**

```bash
git add skills/telegram/mcp-server.ts
git commit -m "feat: Layer 2 show_progress tool — agent-controlled progress messages"
```

---

### Task 4: agent-loop — 移除全部 typing/progress 硬编码

**Files:**
- Modify: `packages/agent-runtime/src/agent-loop.ts`
- Delete: `packages/agent-runtime/src/progress-tracker.ts`

**Step 1: 移除 imports 和模块级常量**

删除以下行：

```typescript
// 删除 import
import { ProgressTracker } from "./progress-tracker.js";

// 删除函数
function sendChatAction(...) { ... }

// 删除常量
const TYPING_INTERVAL_MS = 4000;
const SEND_TOOLS = new Set([...]);
```

**Step 2: 清理 `runSdkLoop` 函数**

在 `runSdkLoop` 中删除所有 typing/progress 相关代码：

1. 删除 `progressTracker` 创建和 `onProgressStarted` 注册（L282-286）
2. 删除 `typingTimer` 变量和 `startTyping`/`stopTyping` 函数（L288-305）
3. 删除 `pumpMessages` 中的 `startTyping()` 和 `progressTracker.setTarget()` 调用（L488-489）
4. 删除首次消息后的 `startTyping()` 和 `progressTracker.setTarget()` 调用（L452-453）
5. 删除 `for await` 中的所有 `progressTracker.*` 调用：
   - `stream_event` handler 中的 `progressTracker.onNewResponse()`、`progressTracker.onToolStarted()`、`stopTyping()`、`progressTracker.cleanup()` (L530-546)
   - `tool_progress` handler 中的 `progressTracker.onToolProgress()` (L550-554)
   - `assistant` handler 中的 `progressTracker.onToolInputResolved()` (L557-567)
   - `result` handler 中的 `stopTyping()` 和 `progressTracker.cleanup()` (L570-571)
   - `system` handler 中的 `progressTracker.onSubAgent*()` (L512-518)
6. 删除 `finally` 中的 `stopTyping()` 和 `progressTracker.cleanup()` (L639-640)

**Step 3: 更新 reportHealth 调用，附带 conversation**

找到 `await kernelClient.reportHealth(agentId, "busy")` 的所有调用，附带 conversation 信息：

在 `pumpMessages` 中（收到新消息时）：
```typescript
await kernelClient.reportHealth(agentId, "busy", {
  sessionId,
  conversation: `${msg.channel}/${msg.conversation.id}`,
}).catch(() => {});
```

在首次消息后（L451）：
```typescript
await kernelClient.reportHealth(agentId, "busy", {
  conversation: `${firstMsg.channel}/${firstMsg.conversation.id}`,
}).catch(() => {});
```

在 `result` handler 的 `idle` 上报中，不需要 conversation（已无活跃会话）。

**Step 4: 删除 `progress-tracker.ts`**

```bash
rm packages/agent-runtime/src/progress-tracker.ts
```

**Step 5: 验证编译**

Run: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json`
Expected: 无错误

**Step 6: Commit**

```bash
git add packages/agent-runtime/src/agent-loop.ts
git rm packages/agent-runtime/src/progress-tracker.ts
git commit -m "refactor: remove all typing/progress logic from agent-loop

agent-loop no longer knows about typing indicators, progress messages,
or SEND_TOOLS. These responsibilities are now in the MCP server (Skill side).
Only reportHealth(busy/idle) remains as the interface."
```

---

### Task 5: MCP server — idle 安全网清理

**Files:**
- Modify: `skills/telegram/mcp-server.ts` (typing 轮询区域)

**Step 1: 在 typing 轮询中添加 idle 时清理残留 progress 消息**

修改 Task 2 中添加的 `setInterval` 回调，添加 idle 清理逻辑：

```typescript
setInterval(async () => {
  try {
    const res = await fetch(`${KERNEL_URL}/api/agent/health`);
    if (!res.ok) return;
    const data = await res.json() as Record<string, { status: string; conversation?: string }>;
    const agent = data[AGENT_ID];
    if (!agent) return;

    if (agent.status === "busy" && agent.conversation) {
      // Layer 2 active → skip typing
      if (progressMsgId) return;

      // Layer 1: send typing
      const [channel, convId] = agent.conversation.split("/", 2);
      if (channel === "telegram" && convId) {
        await sendTyping(convId);
      }
    } else if (agent.status === "idle" || agent.status === "alive") {
      // Safety net: clean up lingering progress message
      if (progressMsgId && progressConv) {
        sendOutbound({
          channel: "telegram",
          conversation: progressConv,
          skillEndpoint: "/delete",
          payload: { conversation: progressConv, messageId: progressMsgId },
        }).catch(() => {});
        progressMsgId = null;
        progressConv = null;
      }
    }
  } catch {
    // Kernel unreachable, silently skip
  }
}, TYPING_POLL_MS);
```

**Step 2: Commit**

```bash
git add skills/telegram/mcp-server.ts
git commit -m "feat: safety net — auto-cleanup lingering progress on agent idle"
```

---

### Task 6: 更新 SKILL.md 文档

**Files:**
- Modify: `skills/telegram/SKILL.md`

**Step 1: 添加 show_progress 到工具列表**

在 `### Polls` 之后添加：

```markdown
### Progress

- `show_progress` — Toggle a progress status message. Use for long-running tasks only (multi-step analysis, complex searches). When active, replaces the automatic typing indicator. Call with `active: false` in parallel with `send_message` when ready to reply.
```

**Step 2: Commit**

```bash
git add skills/telegram/SKILL.md
git commit -m "docs: add show_progress tool to SKILL.md"
```

---

### Task 7: 更新 docs/design.md

**Files:**
- Modify: `docs/design.md`

**Step 1: 更新模块描述**

找到 agent-loop.ts 的描述，移除 ProgressTracker/typing 相关内容。

找到 mcp-server.ts 的描述，添加 typing 轮询和 show_progress 工具说明。

描述新的两层反馈模型：
- Layer 1 (typing): MCP server 轮询 Kernel `GET /api/agent/health`，检测 busy 状态 + conversation，自动发 typing
- Layer 2 (progress): Agent 调用 `show_progress` 工具，MCP server 管理 progress 消息生命周期

**Step 2: 移除 progress-tracker.ts 从文件树**

**Step 3: Commit**

```bash
git add docs/design.md
git commit -m "docs: update design.md for two-layer feedback model"
```

---

### Task 8: 构建、部署、验证

**Step 1: 完整 TypeScript 编译检查**

```bash
npx tsc --noEmit -p packages/types/tsconfig.json
npx tsc --noEmit -p packages/kernel/tsconfig.json
npx tsc --noEmit -p packages/agent-runtime/tsconfig.json
```

**Step 2: 重启 Kernel（host）**

```bash
# 先停掉旧 Kernel 进程
pkill -f "tsx packages/kernel/src/index.ts" || true
# 启动新 Kernel
npx tsx packages/kernel/src/index.ts &
```

**Step 3: 构建并部署容器**

```bash
./scripts/deploy.sh --build --logs
```

**Step 4: 验证 Layer 1 (typing)**

1. 发送一条 Telegram 消息
2. 观察：bot 应显示 "typing..." 状态
3. 检查日志：不应有 ProgressTracker 相关输出

**Step 5: 验证 Layer 2 (show_progress)**

1. 发送需要多步处理的消息（如 "分析一下今天的聊天记录"）
2. 观察：Agent 应调用 `show_progress` 显示进度消息
3. Agent 回复后 progress 消息应被删除

**Step 6: 验证安全网**

1. 发送 `/interrupt` 中断 Agent
2. 如果有残留 progress 消息，应在下个 5s 轮询周期被自动清理

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: two-layer feedback model — typing auto-poll + show_progress tool

Layer 1: MCP server polls Kernel health, auto-sends typing when busy
Layer 2: Agent calls show_progress for long tasks, replaces typing
Safety net: lingering progress auto-cleaned on agent idle"
```

---

## 变更汇总

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/types/src/kernel-api.ts` | 修改 | `AgentHealthReport` 添加 `conversation` 字段 |
| `packages/kernel/src/agent-supervisor.ts` | 修改 | 添加 `getAllHealth()`，返回值含 `conversation` |
| `packages/kernel/src/http-server.ts` | 修改 | 添加 `GET /api/agent/health` |
| `packages/agent-runtime/src/agent-loop.ts` | 修改 | 移除 ProgressTracker/typing/SEND_TOOLS，reportHealth 附带 conversation |
| `packages/agent-runtime/src/progress-tracker.ts` | 删除 | 整个文件（405 行） |
| `skills/telegram/mcp-server.ts` | 修改 | 添加 typing 轮询 + `show_progress` 工具 + idle 安全网 |
| `skills/telegram/SKILL.md` | 修改 | 添加 `show_progress` 工具文档 |
| `docs/design.md` | 修改 | 更新两层反馈模型描述 |

**净效果**：agent-loop.ts 移除 ~80 行 typing/progress 代码 + 删除 405 行 progress-tracker.ts，MCP server 新增 ~80 行。agent-loop 变为 channel-agnostic。
