# Claude Agent SDK 使用指南

> 包名: `@anthropic-ai/claude-agent-sdk` (原 `@anthropic-ai/claude-code`)
> 当前版本: v0.2.71+
> 最后更新: 2026-03-10

---

## 一、核心 API

### 1.1 `query()` — 唯一入口

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

返回 `Query` 对象，实现了 `AsyncGenerator<SDKMessage, void>`，用 `for await...of` 消费：

```typescript
for await (const message of query({ prompt: "Hello", options })) {
  if (message.type === "assistant") {
    // Claude 回复
  }
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
    console.log(message.session_id);      // 用于后续 resume
    console.log(message.total_cost_usd);  // 本次花费
  }
}
```

### 1.2 `prompt` 两种形式

**字符串** — 单次输入：
```typescript
query({ prompt: "分析这个项目的架构" })
```

**AsyncIterable** — 流式输入（持续消息流）：
```typescript
async function* messageStream(): AsyncIterable<SDKUserMessage> {
  while (true) {
    const msg = await waitForNextMessage();
    yield {
      type: "user",
      session_id: "",  // SDK 自动填充
      message: { role: "user", content: msg.text },
      parent_tool_use_id: null,
    };
  }
}

query({ prompt: messageStream(), options })
```

流式输入是构建持久 Agent 服务的关键——外部消息源（消息队列、WebSocket、Telegram）可以直接管道进 agent。

---

## 二、Options 完整配置

### 2.1 模型与执行控制

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `model` | `string` | CLI 默认 | 如 `"claude-opus-4-6"`, `"opus"`, `"sonnet"` |
| `maxTurns` | `number` | 无限制 | 最大工具调用轮次 |
| `maxBudgetUsd` | `number` | 无限制 | 美元预算上限 |
| `effort` | `'low'\|'medium'\|'high'\|'max'` | `'high'` | 思考深度 |
| `cwd` | `string` | `process.cwd()` | 工作目录 |
| `env` | `Record<string, string\|undefined>` | `process.env` | 传递给 agent 的环境变量 |
| `abortController` | `AbortController` | 自动创建 | 手动取消 |

### 2.2 System Prompt

```typescript
systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string }
```

三种模式：

```typescript
// 模式 1: 完全自定义（失去内置工具指令）
systemPrompt: "You are ..."

// 模式 2: claude_code preset（获得完整 Claude Code 能力）
systemPrompt: { type: "preset", preset: "claude_code" }

// 模式 3: preset + 追加（推荐）
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: "你是 CodeClaw Agent。工作目录结构：memory/, skills/, config/"
}
```

> **注意**: SDK 默认使用极简 system prompt，**必须**显式指定 `preset: 'claude_code'` 才能获得文件读写、代码编辑等完整能力。

### 2.3 CLAUDE.md 加载

```typescript
settingSources?: ("user" | "project" | "local")[]
```

| 值 | 加载路径 |
|----|----------|
| `"project"` | `{cwd}/CLAUDE.md` |
| `"user"` | `~/.claude/CLAUDE.md` |
| `"local"` | `{cwd}/.claude/CLAUDE.local.md` |

> **注意**: 默认值为 `[]`（不加载任何文件）。要读取项目 CLAUDE.md **必须**显式传 `settingSources: ["project"]`。preset 本身不触发加载。

### 2.4 工具控制

| 字段 | 类型 | 说明 |
|------|------|------|
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | 工具集 |
| `allowedTools` | `string[]` | 预批准白名单（无需询问即执行） |
| `disallowedTools` | `string[]` | 黑名单（始终拒绝，优先于 bypassPermissions） |
| `permissionMode` | `PermissionMode` | 权限模式 |
| `canUseTool` | `CanUseTool` | 运行时权限回调 |

> **易混淆点**: `allowedTools` 的含义是"预批准"，不是"仅允许"。未列出的工具会流转到 `permissionMode` 处理，不会自动拒绝。要限制工具范围，配合 `permissionMode: 'dontAsk'` 使用。

### 2.5 会话管理

| 字段 | 类型 | 说明 |
|------|------|------|
| `continue` | `boolean` | 继续当前目录最近一次会话 |
| `resume` | `string` | 恢复指定 sessionId |
| `forkSession` | `boolean` | 配合 resume：分叉新会话，原会话不变 |
| `sessionId` | `string` | 手动指定新会话 UUID |
| `persistSession` | `boolean` | 默认 `true`，设 `false` 为纯内存会话 |

### 2.6 MCP 服务器

```typescript
mcpServers?: Record<string, McpServerConfig>
```

详见 §四。

### 2.7 Hooks

```typescript
hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>
```

详见 §五。

---

## 三、权限管理

### 3.1 PermissionMode

```typescript
type PermissionMode =
  | "default"           // 标准权限询问
  | "acceptEdits"       // 自动批准文件操作
  | "bypassPermissions" // 跳过所有安全提示（需配合 allowDangerouslySkipPermissions: true）
  | "plan"              // 规划模式：只分析不执行
  | "dontAsk"           // 未预批准的工具直接拒绝
```

### 3.2 决策优先级

```
PreToolUse Hook → disallowedTools → allowedTools → permissionMode → canUseTool
```

### 3.3 常用权限模式

**Daemon 模式（全自动）**:
```typescript
{
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  // 配合 hooks 做安全拦截
}
```

**锁定模式（仅白名单工具）**:
```typescript
{
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk",
  // 非白名单工具静默拒绝
}
```

### 3.4 `canUseTool` 回调

```typescript
canUseTool: async (toolName, input, options) => {
  if (toolName === "Bash" && isDangerous(input.command)) {
    return { behavior: "deny", message: "危险命令被拦截" };
  }
  return { behavior: "allow" };
}
```

---

## 四、MCP 服务器集成

### 4.1 四种传输类型

**stdio — 本地子进程（最常用）**:
```typescript
mcpServers: {
  github: {
    type: "stdio",             // 可省略，默认值
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "..." },
  }
}
```

**sse — 远程 Server-Sent Events**:
```typescript
mcpServers: {
  remote: {
    type: "sse",
    url: "https://mcp.example.com/sse",
    headers: { Authorization: "Bearer ..." },
  }
}
```

**http — 远程 HTTP**:
```typescript
mcpServers: {
  remote: {
    type: "http",
    url: "https://mcp.example.com/api",
    headers: { Authorization: "Bearer ..." },
  }
}
```

**sdk — 进程内自定义工具（无需独立进程）**:
```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const sendMessage = tool(
  "send_message",
  "发送消息到指定通道",
  { channel: z.string(), text: z.string() },
  async ({ channel, text }) => ({
    content: [{ type: "text" as const, text: `已发送到 ${channel}` }],
  })
);

const mcpServer = createSdkMcpServer({
  name: "codeclaw",
  tools: [sendMessage],
});

mcpServers: {
  codeclaw: mcpServer   // type: "sdk" 自动推断
}
```

### 4.2 工具命名约定

MCP 工具名遵循 `mcp__<server>__<tool>` 格式：

```typescript
allowedTools: [
  "mcp__codeclaw__send_message",
  "mcp__codeclaw__update_progress",
]
```

### 4.3 MCP 连接状态检查

```typescript
for await (const message of query({ prompt, options })) {
  if (message.type === "system" && message.subtype === "init") {
    const failed = message.mcp_servers.filter(s => s.status !== "connected");
    if (failed.length > 0) console.warn("MCP 连接失败:", failed);
  }
}
```

### 4.4 运行时动态管理

```typescript
const q = query({ prompt: stream, options });

// 热更新 MCP 服务器配置
await q.setMcpServers({ newServer: { command: "...", args: [...] } });

// 重连
await q.reconnectMcpServer("codeclaw");

// 启用/禁用
await q.toggleMcpServer("codeclaw", false);
```

---

## 五、Hooks 系统

### 5.1 所有 Hook 事件

| 事件 | 触发时机 | 可阻断 |
|------|----------|--------|
| `PreToolUse` | 工具调用前 | 是（deny/allow/ask） |
| `PostToolUse` | 工具执行后 | 否（可追加上下文） |
| `PostToolUseFailure` | 工具执行失败 | 否 |
| `UserPromptSubmit` | 用户提示提交时 | 否 |
| `Stop` | Agent 停止 | 否 |
| `SubagentStart` | 子 Agent 启动 | 是（可注入上下文） |
| `SubagentStop` | 子 Agent 完成 | 否（可读取结果） |
| `PreCompact` | 上下文压缩前 | 否 |
| `Notification` | 状态通知 | 否 |
| `SessionStart` | 会话初始化 (TS only) | 否 |
| `SessionEnd` | 会话结束 (TS only) | 否 |
| `PermissionRequest` | 权限请求 | 否 |
| `Setup` | SDK 初始化设置 | 否 |
| `TeammateIdle` | 队友 Agent 空闲 | 否 |
| `TaskCompleted` | 任务完成 | 否 |
| `Elicitation` | 向用户请求输入 | 否 |
| `ElicitationResult` | 用户输入结果 | 否 |
| `ConfigChange` | 配置变更 | 否 |
| `WorktreeCreate` | Git worktree 创建 | 否 |
| `WorktreeRemove` | Git worktree 移除 | 否 |
| `InstructionsLoaded` | CLAUDE.md 等指令加载 | 否 |

### 5.2 Hook 配置结构

```typescript
hooks: {
  PreToolUse: [
    {
      matcher: "Bash|Write",    // 正则匹配工具名（可选，不填匹配所有）
      hooks: [callbackFn],      // 回调数组，按序执行
      timeout: 60,              // 超时秒数
    }
  ]
}
```

### 5.3 Hook 回调签名

```typescript
type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

`PreToolUse` 输入结构：
```typescript
{
  hook_event_name: "PreToolUse",
  tool_name: string,
  tool_input: unknown,     // 需手动 cast
  tool_use_id: string,
  session_id: string,
  cwd: string,
}
```

### 5.4 PreToolUse 返回值

```typescript
return {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow" | "deny" | "ask",
    permissionDecisionReason: "原因说明",
    // 可选：修改工具输入（修改时必须同时返回 allow）
    updatedInput: { ...modifiedInput },
  }
};

// 或返回空对象（不干预）
return {};
```

多个 hook 的优先级：**deny > ask > allow**。任一 hook 返回 deny，操作即被阻断。

### 5.5 实用示例

**保护敏感文件**:
```typescript
const protectFiles: HookCallback = async (input) => {
  const { tool_name, tool_input } = input as PreToolUseHookInput;
  const filePath = (tool_input as any)?.file_path as string;

  if (filePath?.includes(".env") || filePath?.includes("secrets")) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "禁止访问敏感文件",
      },
    };
  }
  return {};
};

hooks: { PreToolUse: [{ matcher: "Write|Edit|Read", hooks: [protectFiles] }] }
```

**审计日志（不阻塞）**:
```typescript
const auditLog: HookCallback = async (input) => {
  logToExternal(input).catch(console.error);  // fire and forget
  return {};
};

hooks: { PostToolUse: [{ hooks: [auditLog] }] }
```

**重定向写操作到沙箱**:
```typescript
const sandbox: HookCallback = async (input) => {
  const { tool_input } = input as PreToolUseHookInput;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...tool_input, file_path: `/sandbox${(tool_input as any).file_path}` },
    },
  };
};

hooks: { PreToolUse: [{ matcher: "Write", hooks: [sandbox] }] }
```

---

## 六、会话管理

### 6.1 会话存储

会话持久化在 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`。

### 6.2 典型多轮模式

```typescript
// 第一轮
let sessionId: string | undefined;
for await (const msg of query({ prompt: "分析代码", options })) {
  if (msg.type === "result") sessionId = msg.session_id;
}

// 第二轮：恢复上下文
for await (const msg of query({
  prompt: "基于刚才的分析，重构 auth 模块",
  options: { ...options, resume: sessionId },
})) { /* ... */ }
```

### 6.3 会话枚举

```typescript
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions({ dir: "/path/to/project", limit: 10 });
const messages = await getSessionMessages(sessions[0].sessionId, {
  dir: "/path/to/project",
  limit: 20,
});
```

### 6.4 跨重启恢复

容器重启后恢复会话，需要：
1. 首次运行从 `result.session_id` 捕获 ID
2. 持久化到外部存储（如内核 API）
3. 下次启动时传入 `resume: savedSessionId`
4. `cwd` 必须与上次一致（影响存储路径编码）

---

## 七、`Query` 对象动态控制

流式输入模式下，`Query` 对象可在运行期间动态调整：

```typescript
const q = query({ prompt: stream, options });

// 动态切换模型
await q.setModel("claude-opus-4-6");

// 动态切换权限
await q.setPermissionMode("bypassPermissions");

// 中断当前轮次
await q.interrupt();

// 热更新 MCP 服务器
await q.setMcpServers({ newServer: config });

// 强制终止
q.close();
```

---

## 八、子 Agent（Subagents）

### 8.1 概念

主 Agent 可以通过内置 `Agent` 工具 spawn 子 Agent。子 Agent 拥有独立的上下文窗口和工具集，完成任务后结果返回主 Agent。

**约束**：子 Agent 嵌套限制为一层——子 Agent 不能再 spawn 子 Agent。但主 Agent 可以并行 spawn 多个子 Agent。

### 8.2 自定义子 Agent（`options.agents`）

通过 `agents` 选项注册自定义子 Agent，它们会出现在 `Agent` 工具的可选列表中：

```typescript
query({
  prompt: stream,
  options: {
    agents: {
      "test-runner": {
        description: "Runs tests and reports results",
        prompt: "You are a test runner. Run the specified tests and report pass/fail.",
        tools: ["Read", "Grep", "Glob", "Bash"],
        model: "sonnet",        // 子 Agent 用更便宜的模型
        maxTurns: 10,           // 限制轮次防止失控
      },
      "code-reviewer": {
        description: "Reviews code for best practices and potential bugs",
        prompt: "You are a code reviewer...",
        model: "inherit",       // 继承主 Agent 的模型
        disallowedTools: ["Write", "Edit"],  // 只读，不能修改代码
      },
    },
  },
});
```

### 8.3 `AgentDefinition` 完整字段

```typescript
type AgentDefinition = {
  description: string;             // 何时使用这个 Agent（自然语言）
  prompt: string;                  // 系统提示
  tools?: string[];                // 允许的工具（省略则继承父 Agent）
  disallowedTools?: string[];      // 显式禁止的工具
  model?: "sonnet" | "opus" | "haiku" | "inherit";  // 省略或 "inherit" 则用主模型
  mcpServers?: AgentMcpServerSpec[];  // 子 Agent 专用 MCP 服务器
  skills?: string[];               // 预加载的 skill 名称
  maxTurns?: number;               // 最大轮次
  criticalSystemReminder_EXPERIMENTAL?: string;  // 关键提醒（实验性）
};
```

### 8.4 主线程指定 Agent（`options.agent`）

让主线程也使用某个 Agent 的配置（system prompt + 工具限制 + 模型）：

```typescript
query({
  prompt: "Review this PR",
  options: {
    agent: "code-reviewer",  // 使用 agents 中定义的 code-reviewer 配置
    agents: {
      "code-reviewer": { /* ... */ },
    },
  },
});
```

### 8.5 运行时查询可用子 Agent

```typescript
const q = query({ prompt: stream, options });

const agents: AgentInfo[] = await q.supportedAgents();
// AgentInfo: { name: string; description: string; model?: string }

for (const a of agents) {
  console.log(`${a.name}: ${a.description} (model: ${a.model ?? "inherit"})`);
}
```

### 8.6 子 Agent 生命周期 Hooks

```typescript
hooks: {
  SubagentStart: [{
    hooks: [async (input) => {
      // input: { agent_id, agent_type, session_id, cwd, ... }
      console.log(`子 Agent 启动: ${input.agent_type} (${input.agent_id})`);
      return {
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext: "额外上下文注入到子 Agent",  // 可选
        },
      };
    }],
  }],
  SubagentStop: [{
    hooks: [async (input) => {
      // input: { agent_id, agent_type, agent_transcript_path, last_assistant_message, ... }
      console.log(`子 Agent 完成: ${input.agent_type}`);
      console.log(`结果: ${input.last_assistant_message}`);
      console.log(`完整记录: ${input.agent_transcript_path}`);
      return {};
    }],
  }],
}
```

### 8.7 Hook 中区分主线程和子 Agent

所有 Hook 的 `BaseHookInput` 包含可选的 `agent_id` 和 `agent_type` 字段：

```typescript
const protectInSubagent: HookCallback = async (input) => {
  if (input.agent_id) {
    // 在子 Agent 中——可能需要更严格的限制
    console.log(`子 Agent ${input.agent_type} 正在调用工具`);
  }
  return {};
};
```

### 8.8 成本优化模式

主 Agent 用 Opus 做策略决策，子 Agent 用 Sonnet 做具体执行：

```typescript
agents: {
  "file-searcher": {
    description: "Search files for patterns",
    prompt: "Search the codebase and return matching files.",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet",     // 便宜
    maxTurns: 5,         // 快速完成
  },
  "deep-analyzer": {
    description: "Deep analysis of complex code",
    prompt: "Analyze the given code in depth.",
    model: "opus",       // 需要强推理
    maxTurns: 20,
  },
}
```

---

## 九、消息类型速查

```typescript
for await (const msg of query({ prompt, options })) {
  switch (msg.type) {
    case "system":    // subtype: "init" — 首条消息，含 MCP 状态、工具列表、model
    case "assistant": // msg.message: BetaMessage — Claude 的回复
    case "user":      // msg.message: MessageParam — 用户输入（含工具结果）
    case "result":    // subtype: "success" | "error_*" — 终止消息
      // success: { result, session_id, total_cost_usd, num_turns }
      // error:   { errors: string[] }
  }
}
```

Result subtype 枚举：

| subtype | 含义 |
|---------|------|
| `success` | 正常完成 |
| `error_max_turns` | 达到 maxTurns 上限 |
| `error_max_budget_usd` | 达到预算上限 |
| `error_during_execution` | 执行出错 |

---

## 十、环境变量传递

SDK 通过 `options.env` 传递环境变量，不支持自定义 `fetch`：

```typescript
options: {
  env: {
    ANTHROPIC_API_KEY: "sk-...",
    ANTHROPIC_BASE_URL: "https://proxy.moedb.moe",
    HTTPS_PROXY: "http://host.docker.internal:7890",
    CLAUDE_MODEL: "aws-claude-opus-4-6",
  }
}
```

---

## 十一、参考链接

- [Agent SDK Overview](https://docs.anthropic.com/en/docs/claude-code/sdk)
- [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Hooks Guide](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [Sessions Guide](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [MCP Integration](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [System Prompt Customization](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Permissions Guide](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [npm: @anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [GitHub: claude-agent-sdk-demos](https://github.com/anthropics/claude-agent-sdk-demos)
