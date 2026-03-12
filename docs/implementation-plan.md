# CodeClaw 实施计划

> 基于设计哲学 V3（`docs/agent-system-design-philosophy.md`），定义从 MVP 到完整系统的实现路径。
> Phase 0-4 为 MVP 阶段（已完成），Phase 5+ 为基于 V3 哲学的增量迭代。

---

## 阶段概览

```
Phase 0: 项目脚手架                    [✅ 已完成]
Phase 1: 最小内核                      [✅ 已完成]
Phase 2: Agent 容器运行时              [✅ 已完成] (SDK/chat/stub 三层模式)
Phase 3: 第一个通道 Skill (Telegram)   [✅ 已完成] (图片/贴纸/群聊@过滤)
Phase 4: 端到端联调                    [✅ 已完成] (SDK 模式全链路验证)
Phase 5: 思考链流式输出                [待开始] — 设计方向 4: Code-first UX
Phase 6: 安全约束与审批                [待开始] — 设计方向 5: 三层安全
Phase 7: 结构化记忆                    [待开始] — 设计方向 1: 存在感核心
Phase 8: Skill 自安装体验              [待开始] — 设计方向 3: Agent 是开发者
Phase 9: 开源发布准备                  [待开始] — CLI + 文档 + 安装体验
```

---

## Phase 0: 项目脚手架

### 目标
建立项目结构、构建工具链、基础类型定义。

### 任务

**0.1 项目初始化**
```
codeclaw/
├── package.json              # monorepo root (pnpm workspace)
├── pnpm-workspace.yaml
├── tsconfig.json
├── packages/
│   ├── kernel/               # 内核进程
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   ├── agent-runtime/        # Agent 容器内的入口程序
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   └── types/                # 共享类型定义
│       ├── package.json
│       └── src/
├── skills/                   # Skill 模板和内置 Skills
│   └── telegram/             # 第一个运行时 Skill
├── workspace-template/       # Agent 工作空间模板
│   ├── CLAUDE.md
│   ├── memory/
│   ├── config/
│   ├── skills/
│   └── scratch/
└── docs/
```

**0.2 共享类型定义** (`packages/types/src/`)
```typescript
// messages.ts — 跨通道统一消息格式
interface InboundMessage {
  id: string;
  channel: string;           // "telegram", "web", "cli"
  sender: {
    id: string;
    name: string;
    channel: string;
  };
  conversation: {
    id: string;              // 会话标识 (群组ID / DM ID)
    type: "group" | "dm";
    title?: string;
  };
  content: MessageContent;   // 文本/图片/音频/文件
  timestamp: number;
  replyTo?: string;          // 回复某条消息
}

interface OutboundMessage {
  channel: string;
  conversation: string;
  content: MessageContent;
  replyTo?: string;
}

type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; url: string; caption?: string }
  | { type: "audio"; url: string; duration?: number }
  | { type: "file"; url: string; filename: string };

// skill-service.ts — Skill 服务注册协议
interface SkillServiceRegistration {
  skillId: string;
  type: "channel" | "tool";
  capabilities: string[];    // ["send_message", "receive_message"]
  endpoint: string;          // "http://localhost:7001"
}

// kernel-api.ts — 内核暴露给容器的 API
interface KernelAPI {
  // 消息
  getNextMessage(): Promise<InboundMessage | null>;
  sendMessage(msg: OutboundMessage): Promise<void>;
  getQueueStatus(): Promise<{ pending: number; channels: string[] }>;
  // Skill 服务
  registerSkillService(reg: SkillServiceRegistration): Promise<void>;
  unregisterSkillService(skillId: string): Promise<void>;
  // 生命周期
  reportHealth(status: "alive" | "busy" | "idle"): Promise<void>;
}
```

**0.3 技术选型确认**
- 语言: TypeScript (ESM), Node.js 22+
- 包管理: pnpm workspace
- 构建: tsdown 或 tsx (开发阶段直接 tsx 运行)
- 容器: Docker + 持久化卷
- 内核 ↔ 容器通信: HTTP (简单, 调试方便, 后续可换 Unix Socket)
- 内核 ↔ Skill 服务通信: HTTP (同上)
- 数据库: SQLite (内核侧消息日志 + Agent 侧记忆)

---

## Phase 1: 最小内核

### 目标
一个可运行的宿主机进程，能管理消息队列、路由消息、监督容器。

### 模块划分

```
packages/kernel/src/
├── index.ts                  # 入口，启动所有子系统
├── message-queue.ts          # 消息队列 (优先级, 去重, 来源标记)
├── io-bridge.ts              # I/O Bridge (Skill 服务注册 + 消息路由)
├── container-manager.ts      # Docker 容器生命周期管理
├── agent-supervisor.ts       # Agent 进程健康监控 + 崩溃重启
├── http-server.ts            # HTTP API 服务 (容器 + Skill 调用)
├── config.ts                 # 内核配置加载
├── logger.ts                 # 日志
└── types.ts                  # 内核内部类型
```

### 任务

**1.1 消息队列** (`message-queue.ts`)
- 内存优先级队列（无需 Redis，个人系统规模小）
- 入队：来源通道 + 消息内容 + 优先级
- 出队：按优先级 FIFO
- 去重：基于消息 ID（防通道重复投递）
- 状态查询：队列长度、各通道待处理数

```typescript
class MessageQueue {
  enqueue(msg: InboundMessage, priority?: number): void;
  dequeue(): InboundMessage | null;
  peek(): InboundMessage | null;
  pendingCount(): number;
  pendingByChannel(): Record<string, number>;
}
```

**1.2 I/O Bridge** (`io-bridge.ts`)
- Skill 服务注册表（内存 Map）
- 注册/注销 Skill 服务
- 入站路由：Skill 服务 → 消息队列
- 出站路由：Agent 发送 → 查找目标通道的 Skill 服务 → 转发

```typescript
class IOBridge {
  registerService(reg: SkillServiceRegistration): void;
  unregisterService(skillId: string): void;
  getServiceForChannel(channel: string): SkillServiceRegistration | null;
  routeOutbound(msg: OutboundMessage): Promise<void>;
  // Skill 服务调用此方法投递入站消息
  handleInbound(msg: InboundMessage): void;
}
```

**1.3 容器管理** (`container-manager.ts`)
- 使用 `dockerode` 库操作 Docker API
- 创建容器：指定镜像、挂载持久化卷、网络配置、环境变量
- 启动/停止/重启容器
- 检查容器状态
- 日志获取

```typescript
class ContainerManager {
  async createAgent(agentId: string, config: AgentContainerConfig): Promise<void>;
  async startAgent(agentId: string): Promise<void>;
  async stopAgent(agentId: string): Promise<void>;
  async restartAgent(agentId: string): Promise<void>;
  async getStatus(agentId: string): Promise<ContainerStatus>;
  async getLogs(agentId: string, tail?: number): Promise<string>;
}
```

**1.4 Agent 监督** (`agent-supervisor.ts`)
- 定期健康检查（HTTP ping 容器内 agent-runtime 的 /health）
- 崩溃检测 → 自动重启容器
- 重启后自动触发 session resume
- 记录最后一个 assistant message UUID（用于 resumeSessionAt）

```typescript
class AgentSupervisor {
  constructor(containerManager: ContainerManager);
  startMonitoring(agentId: string, interval: number): void;
  stopMonitoring(agentId: string): void;
  onCrash(agentId: string, callback: () => void): void;
}
```

**1.5 HTTP API 服务** (`http-server.ts`)
- 端口: 内核配置指定（默认 19000）
- 路由:

```
POST /api/messages/inbound     ← Skill 服务投递入站消息
POST /api/messages/outbound    ← Agent 发送出站消息
GET  /api/messages/next        ← Agent 拉取下一条消息
GET  /api/messages/queue       ← 队列状态查询

POST /api/services/register    ← Skill 服务注册
POST /api/services/unregister  ← Skill 服务注销

POST /api/agent/health         ← Agent 健康上报
GET  /api/status               ← 内核总体状态
```

用 express 或原生 http 模块即可，不需要框架。

**1.6 内核配置** (`config.ts`)

```yaml
# codeclaw.yaml
kernel:
  port: 19000
  log_level: info

agent:
  id: andy
  image: codeclaw/agent-runtime:latest
  workspace_volume: agent-andy-workspace
  api_key_env: ANTHROPIC_API_KEY     # 或中转 API 地址
  default_model: opus

# Skill 服务不在此配置 — agent 自行管理
```

---

## Phase 2: Agent 容器运行时

### 目标
容器内运行的入口程序，负责启动 Claude Agent SDK 进程 + 与内核通信 + 管理 Skill 服务。

### 模块划分

```
packages/agent-runtime/src/
├── index.ts                  # 容器入口
├── agent-loop.ts             # Agent SDK 调用 (Streaming Input)
├── kernel-client.ts          # 与内核 HTTP API 通信
├── message-injector.ts       # 将内核消息注入 Agent 的 Streaming Input
├── skill-service-manager.ts  # 容器内 Skill 服务进程管理
└── mcp-server.ts             # Agent 的 MCP 工具 (发消息/管理 Skill 等)
```

### 任务

**2.1 Agent Loop** (`agent-loop.ts`)
核心：调用 SDK `query()` with Streaming Input

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

async function* messageStream(): AsyncGenerator<SDKUserMessage> {
  // 1. 等内核消息队列有消息
  // 2. 拉取消息，格式化为 SDK 的 user message
  // 3. yield 给 Agent
  // 4. Agent 处理中：周期性检查是否有新消息
  //    - 有且 agent 正在工具调用间隙 → yield 系统通知
  //    - 无 → 继续等待
}

for await (const event of query({
  prompt: messageStream(),
  options: {
    cwd: process.env.HOME,           // /home/codeclaw
    resume: lastSessionId,          // 崩溃恢复
    systemPrompt: { type: "preset", preset: "claude_code" },
    allowedTools: [
      "Bash", "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch", "Agent",
      "mcp__codeclaw__*"
    ],
    permissionMode: "bypassPermissions",
    settingSources: ["project"],     // 读取 ~/CLAUDE.md
    mcpServers: {
      codeclaw: {
        command: "node",
        args: ["/app/mcp-server.js"],
        env: { KERNEL_URL: "http://host.docker.internal:19000" }
      }
    },
    hooks: {
      PreCompact: [{ hooks: [preCompactHook] }],
    }
  }
})) {
  // 处理 SDK 事件：
  // - result → 提取回复文本 → 通过 MCP 或 kernel-client 发送
  // - system/init → 记录 session_id
  // - assistant → 记录 UUID (用于 resumeSessionAt)
}
```

**2.2 消息注入器** (`message-injector.ts`)
- 周期性轮询内核 `GET /api/messages/next`
- 格式化为 SDK 消息格式
- 通过 AsyncGenerator yield 给 agent
- **关键**：在 agent 工具调用间隙注入新通道消息的系统通知

```typescript
class MessageInjector {
  private queue: InboundMessage[] = [];
  private resolveWaiter: ((msg: InboundMessage) => void) | null = null;

  // 内核有新消息时调用
  push(msg: InboundMessage): void;

  // Agent loop 的 AsyncGenerator 调用
  async waitForMessage(): Promise<InboundMessage>;

  // 检查是否有待处理消息（用于间隙注入）
  hasPending(): boolean;
  peekPending(): InboundMessage | null;
}
```

**2.3 MCP Server** (`mcp-server.ts`)
Agent 可调用的 MCP 工具：

```typescript
// 核心通信工具
server.tool("send_message", "发送消息到指定通道/会话", {
  channel: { type: "string" },
  conversation: { type: "string" },
  text: { type: "string" },
  replyTo: { type: "string", optional: true }
}, async (args) => {
  await kernelClient.sendMessage(args);
  return { success: true };
});

server.tool("get_queue_status", "查看待处理消息队列", {}, async () => {
  return await kernelClient.getQueueStatus();
});

// Skill 管理工具
server.tool("start_skill_service", "启动一个 Skill 服务", {
  skillId: { type: "string" },
  command: { type: "string" },
  args: { type: "array", items: { type: "string" } }
}, async (args) => {
  await skillServiceManager.start(args);
  return { success: true };
});

server.tool("stop_skill_service", "停止一个 Skill 服务", {
  skillId: { type: "string" }
}, async (args) => {
  await skillServiceManager.stop(args.skillId);
  return { success: true };
});

server.tool("list_skill_services", "列出运行中的 Skill 服务", {}, async () => {
  return skillServiceManager.list();
});
```

**2.4 Skill 服务管理器** (`skill-service-manager.ts`)
- 在容器内 spawn Skill 服务子进程
- 监控进程健康
- 崩溃重启
- 记录活跃 Skill 服务列表

**2.5 Dockerfile**

```dockerfile
FROM node:22-slim

# 安装 Claude Agent SDK CLI
RUN npm install -g @anthropic-ai/claude-code

# 安装常用工具
RUN apt-get update && apt-get install -y \
    git curl wget jq sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# 复制 agent-runtime
COPY packages/agent-runtime/dist /app
COPY packages/agent-runtime/package.json /app/

WORKDIR /app
RUN npm install --omit=dev

# workspace 通过卷挂载
VOLUME /workspace
WORKDIR /workspace

# 启动
CMD ["node", "/app/index.js"]
```

**2.6 workspace 模板** (`workspace-template/`)

```
workspace-template/
├── CLAUDE.md                 # Agent 自我认知 (见下文)
├── memory/
│   └── .gitkeep
├── skills/
│   └── .gitkeep
├── config/
│   └── agent.yaml            # Agent 级配置
└── scratch/
    └── .gitkeep
```

**CLAUDE.md 内容（核心——Agent 的"自我认知"）**：

```markdown
# 你是 CodeClaw Agent

## 你的工作环境
- 你运行在一个持久化的 Docker 容器中
- ~ (/home/codeclaw) 是你的家目录，所有文件在重启后保留
- 你通过 MCP 工具 (codeclaw) 与外界通信

## 目录结构
- ~/.claude/skills/     — 已安装的 Skills，每个有 SKILL.md
- ~/.claude/data/       — Skill 持久化数据（按 skill-id 隔离）
- ~/.claude/cache/      — 临时文件（可安全清理）
- ~/.claude/memory/     — 你的长期记忆 (knowledge.db 是 SQLite FTS5)
- ~/.claude/config/     — 配置文件
- ~/.claude/projects/   — SDK session 数据（自动管理）

## 如何与用户通信
- 使用 send_message 工具发送消息
- 使用 get_queue_status 查看待处理消息
- 新消息会在你的工具调用间隙自动通知你
- 聊天记录由通道 Skill 持久化到 ~/.claude/data/<channel>/，你可以用 Grep 按需查阅

## 如何管理 Skills
- 查看已安装 Skills: ls ~/.claude/skills/
- 阅读 Skill 说明: cat ~/.claude/skills/<name>/SKILL.md
- 启动 Skill 服务: 使用 start_skill_service 工具
- Skill 配置写在 ~/.claude/config/<skill-name>.json

## 记忆管理
- 重要的事实和偏好 → 写入 ~/.claude/memory/knowledge.db
- 长篇笔记和总结 → 写入 ~/.claude/memory/ 下的 .md 文件
- 对话历史由 SDK 自动管理，你不需要手动保存

## 你的行为准则
- 你是一个有持续性的助手，不是一次性工具
- 跨通道的对话共享记忆——Telegram 里的用户和 Web 里的是同一个人
- 需要时主动查阅 Skill 说明书，不要猜测
- 不确定的事情就说不确定，不要幻觉
```

---

## Phase 3: 第一个通道 Skill — Telegram

### 目标
一个自包含的 Telegram 通道 Skill，能收发消息。

### Skill 结构

```
~/.claude/skills/telegram/
├── SKILL.md              # Agent 读的说明书
├── service.ts             # Telegram Bot 服务
├── config.schema.json     # 配置 schema
├── package.json           # 依赖 (grammy)
└── tsconfig.json
```

### 任务

**3.1 SKILL.md**

```markdown
# Telegram 通道 Skill

## 功能
收发 Telegram 消息。安装后，你可以通过 Telegram Bot 与用户对话。

## 安装步骤
1. 确保 ~/.claude/config/telegram.json 存在且包含 bot_token
2. 安装依赖: cd ~/.claude/skills/telegram && npm install
3. 启动服务: 使用 start_skill_service 工具
   - skillId: "telegram"
   - command: "node"
   - args: ["~/.claude/skills/telegram/service.js"]

## 配置 (~/.claude/config/telegram.json)
{
  "bot_token": "必填, 从 @BotFather 获取",
  "allowed_users": ["可选, Telegram user ID 白名单, 留空则允许所有人"]
}

## 验证安装
服务启动后，向你的 Telegram Bot 发一条消息。
如果队列中出现来自 telegram 通道的消息，说明安装成功。

## 已知限制
- 图片/文件消息暂不支持，仅文本
- 群组消息需要 @mention bot 才会触发
```

**3.2 service.ts**

```typescript
// 伪代码，实际实现
import { Bot } from "grammy";

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude/config/telegram.json")));
const bot = new Bot(config.bot_token);
const KERNEL_URL = process.env.KERNEL_URL || "http://host.docker.internal:19000";

// 向内核注册
await fetch(`${KERNEL_URL}/api/services/register`, {
  method: "POST",
  body: JSON.stringify({
    skillId: "telegram",
    type: "channel",
    capabilities: ["send_message", "receive_message"],
    endpoint: `http://localhost:${SERVICE_PORT}`
  })
});

// 接收 Telegram 消息 → 投递给内核
bot.on("message:text", async (ctx) => {
  await fetch(`${KERNEL_URL}/api/messages/inbound`, {
    method: "POST",
    body: JSON.stringify({
      id: String(ctx.message.message_id),
      channel: "telegram",
      sender: {
        id: String(ctx.from.id),
        name: ctx.from.first_name,
        channel: "telegram"
      },
      conversation: {
        id: String(ctx.chat.id),
        type: ctx.chat.type === "private" ? "dm" : "group",
        title: ctx.chat.title
      },
      content: { type: "text", text: ctx.message.text },
      timestamp: ctx.message.date * 1000
    })
  });
});

// 接收内核出站消息 → 发送到 Telegram
// HTTP 端点供内核调用
app.post("/send", async (req, res) => {
  const { conversation, content } = req.body;
  await bot.api.sendMessage(conversation, content.text);
  res.json({ success: true });
});

bot.start();
```

**3.3 config.schema.json**

```json
{
  "type": "object",
  "required": ["bot_token"],
  "properties": {
    "bot_token": {
      "type": "string",
      "description": "Telegram Bot Token, 从 @BotFather 获取"
    },
    "allowed_users": {
      "type": "array",
      "items": { "type": "string" },
      "description": "允许的 Telegram user ID 列表，空数组表示允许所有人",
      "default": []
    }
  }
}
```

---

## Phase 4: 端到端联调

### 目标
完整链路跑通：Telegram 消息 → 内核 → Agent → 回复 → Telegram。

### 任务

**4.1 启动顺序**
```bash
# 1. 构建 agent-runtime 镜像
docker build -t codeclaw/agent-runtime:latest -f packages/agent-runtime/Dockerfile .

# 2. 创建持久化卷并初始化 workspace
docker volume create agent-andy-workspace
# 复制 workspace-template 到卷中

# 3. 启动内核
cd packages/kernel && tsx src/index.ts

# 4. 内核自动：创建并启动 agent 容器
#    容器内 agent-runtime 自动启动

# 5. 用户通过 CLI 或 agent 自身安装 Telegram skill
#    agent 读 ~/.claude/skills/telegram/SKILL.md → 要求用户提供 bot_token → 写配置 → 启动服务
```

**4.2 验证清单**
- [ ] 内核启动，HTTP API 可访问
- [ ] Agent 容器启动，SDK 进程运行
- [ ] Agent 能读取 CLAUDE.md，理解自己的环境
- [ ] Agent 能通过 MCP 工具发送消息
- [ ] Telegram Skill 服务启动，向内核注册
- [ ] 用户发 Telegram 消息 → 内核收到 → Agent 收到
- [ ] Agent 回复 → 内核路由 → Telegram 发出
- [ ] Agent 容器重启后 → session resume → 记忆保留
- [ ] 多条消息快速发送 → 队列正确排队 → 逐条处理

**4.3 已知需要处理的边界情况**
- Agent SDK 首次启动的 ~12s 延迟（第一条消息响应慢，后续正常）
- 消息格式中的特殊字符转义（Telegram Markdown vs SDK 纯文本）
- Docker 网络：容器内访问宿主机的内核 API（`host.docker.internal`）
- 持久化卷权限（容器内 node 用户 vs 卷的文件所有者）

---

## Phase 5: 活跃状态 + 思考链流式输出

> 设计方向 4 — Code-first UX: 看得见的思考

### 目标
Agent 处理消息时，用户看到拟人化的活跃状态；执行复杂任务时，看到实时更新的思考过程。

### 核心基础设施：Agent → Kernel → Skill 非消息通道

Phase 5 的两个功能（chat action 和消息编辑）共用同一条管道：

```
agent-loop.ts (拦截 SDK 事件)
  → Kernel HTTP API (转发)
    → Channel Skill HTTP 端点 (执行)
      → Telegram API (sendChatAction / editMessageText)
```

### 5A: 拟人化 Chat Action（typing 等状态）

Agent 处理消息时自动发送 Telegram chat action，无需 Agent 主动调用，零 token 开销。

**工具类型 → chat action 映射**：
| SDK 工具调用 | Telegram Action | 用户看到 |
|---|---|---|
| Read, Glob, Grep | `typing` | "正在输入..." |
| Write, Edit | `typing` | "正在输入..." |
| Bash | `typing` | "正在输入..." |
| WebSearch, WebFetch | `find_location` | "正在搜索位置..." |
| Agent (subagent) | `typing` | "正在输入..." |
| send_message (图片) | `upload_photo` | "正在发送照片..." |
| send_message (文件) | `upload_document` | "正在发送文件..." |

> 映射表可后续调整，核心是不同操作给出不同的"人类感"反馈。

**任务**：

**5A.1 Kernel action 转发 API**
- 新增 `POST /api/messages/action`
- 消息格式：`{ channel, conversation, action }` （action = Telegram chat action 字符串）
- Kernel 查找 channel 对应的 Skill，转发到 Skill 的 `/action` 端点

**5A.2 Telegram Skill action 端点**
- 新增 `POST /action` 端点
- 调用 `bot.api.sendChatAction(conversation, action)`

**5A.3 agent-loop.ts 自动拦截**
- 在 `for await (const msg of q)` 中，拦截 `assistant` 类型消息
- 检测 tool_use content block → 根据工具名查映射表 → 通过 kernelClient 发 action
- 节流：同一 conversation 最多每 4 秒发一次（chat action 持续 5 秒）

**验证**：
- [ ] Agent 收到消息开始处理时，Telegram 显示 "正在输入..."
- [ ] 不同工具调用显示不同状态
- [ ] Agent 回复后状态自然消失
- [ ] 零 token 开销（Agent 无感知）

### 5B: 思考链流式消息编辑

在 chat action 基础上，进一步通过 `editMessageText` 展示具体工具调用链：

```
🔍 正在读取 config.yaml...
```
→ 编辑为 →
```
🔍 读取了 config.yaml
📝 正在修改端口配置...
```
→ 最终编辑为 →
```
✅ 已将端口从 3000 改为 8080，测试通过。
```

**任务**：

**5B.1 Kernel progress 转发 API**
- 新增 `POST /api/messages/progress`
- 消息格式：`{ channel, conversation, messageId?, text }` — 有 messageId 则编辑，无则新建
- Kernel 转发给对应 Channel Skill

**5B.2 Telegram Skill 编辑消息端点**
- 新增 `POST /edit` 端点
- 调用 `bot.api.editMessageText(chatId, messageId, text)`
- 返回 messageId 供后续编辑

**5B.3 SDK 事件流 → 进度提取**
- 在 agent-loop.ts 中，拦截 `assistant` 类型消息
- 提取工具调用名称和参数摘要，格式化为进度文本
- 节流：最多 1 次/秒编辑（Telegram API 软限制）

**5B.4 MCP 进度工具**
- 在 `sdk-mcp-tools.ts` 新增 `update_progress` 工具
- Agent 也可以主动报告进度（而不仅仅是自动提取）

**验证**：
- [ ] Agent 执行多步工具调用时，Telegram 消息实时更新
- [ ] 编辑频率不超过 1 次/秒
- [ ] 最终消息替换为完整回复

---

## Phase 6: 安全约束与审批

> 设计方向 5 — 三层安全: 隔离 + 约束 + 审批

### 目标
在 Docker 隔离（已有）之上，增加白名单约束和 Emoji 审批。

### 三层模型
```
Layer 1: Docker 隔离        [✅ 已有] 非 root, volume mount, 网络代理
Layer 2: 约束白名单          [待实现] Agent 能做什么
Layer 3: 交互式审批          [待实现] 危险操作需人类确认
```

### 任务

**6.1 约束白名单 (Kernel 级)**
- `codeclaw.yaml` 新增 `security` 配置段：
  ```yaml
  security:
    outbound_channels: ["telegram"]        # Agent 能发消息的通道
    allowed_conversations: []              # 空 = 不限制; 非空 = 白名单
    approvers: ["telegram:12345678"]       # 有审批权的用户 (channel:userId)
  ```
- Kernel 的 `IOBridge.routeOutbound()` 在转发前检查白名单
- 白名单存在容器外（Kernel 配置），Agent 无法修改自己的约束

**6.2 Emoji 审批协议**
- 新增 Kernel API: `POST /api/approval/request` + `POST /api/approval/respond`
- 流程：
  1. Agent MCP 工具触发审批 → Kernel 创建 pending approval
  2. Kernel 通过 Channel Skill 发审批消息到 Telegram
  3. 用户 react 👍/👎 → Telegram Skill 检测 `message_reaction` → 回调 Kernel
  4. Kernel 通知 Agent 审批结果
- 超时：可配置（默认 5 分钟），超时自动拒绝

**6.3 Telegram Skill 支持 Reaction 检测**
- Grammy: `bot.on("message_reaction")` 监听 reaction 事件
- 验证 reactor 是否在 approvers 白名单中
- 匹配 reaction 到 pending approval（通过 messageId）

**6.4 Agent 侧审批 MCP 工具**
- 新增 `request_approval` MCP 工具
- Agent 在执行危险操作前主动调用
- 阻塞等待审批结果后继续

### 验证
- [ ] 非白名单通道的出站消息被 Kernel 拒绝
- [ ] Agent 调用 `request_approval` → Telegram 出现审批消息
- [ ] 白名单用户 react 👍 → Agent 收到批准并继续
- [ ] 超时 → Agent 收到拒绝
- [ ] 非白名单用户的 reaction 被忽略

---

## Phase 7: 结构化记忆

> 设计方向 1 — 存在感核心: 记忆 + 主动行为 + 工作连续性

### 目标
Agent 拥有跨会话、跨通道的持久记忆，能记住用户偏好和历史事实。

### 架构
```
~/.claude/memory/
├── knowledge.db       # SQLite FTS5 — 结构化事实和偏好
├── notes/             # Markdown 长篇笔记和总结
└── index.md           # Agent 自维护的记忆索引
```

### 任务

**7.1 SQLite FTS5 记忆数据库**
- Agent 通过 Bash 工具操作 SQLite（不需要额外 MCP 工具）
- 表结构：
  ```sql
  CREATE VIRTUAL TABLE memories USING fts5(
    key,              -- 唯一标识 (user_preference:timezone)
    content,          -- 记忆内容
    category,         -- 分类 (fact, preference, event, note)
    source,           -- 来源 (telegram:chat_123, manual)
    created_at,
    accessed_at,
    access_count,
    importance        -- 0.0-1.0
  );
  ```

**7.2 workspace CLAUDE.md 记忆指引**
- 更新 `workspace-template/CLAUDE.md`，增加记忆管理指南
- 告诉 Agent 何时存记忆、如何检索、如何衰减过时信息

**7.3 时间衰减评分**（参考 TinyClaw）
- 检索时的相关性公式：
  `relevance = fts5_rank × 0.4 + temporal_score × 0.3 + importance × 0.3`
- 其中 `temporal_score = e^(-0.05 × days) × (1 + 0.02 × access_count)`
- Agent 在 CLAUDE.md 中理解这个公式，自行实现检索逻辑

### 验证
- [ ] Agent 被告知用户偏好 → 存入 knowledge.db
- [ ] 后续对话中 Agent 检索到之前的偏好
- [ ] 旧记忆的 temporal_score 逐渐衰减
- [ ] Agent 容器重启后记忆保留

---

## Phase 8: Skill 自安装体验

> 设计方向 3 — Agent 是开发者: 写代码就是最自然的配置方式

### 目标
用户说 "帮我装一个天气推送"，Agent 自己完成全部安装流程。

### 两种 Skill 形态

| | 通道 Skill | 工具 Skill |
|---|---|---|
| 例子 | Telegram, Discord, Web | 天气查询, 翻译, 计算 |
| 运行方式 | 独立进程，持续监听 | Agent 自写脚本，按需调用 |
| 注册 | 向 Kernel 注册 | 不需要注册 |
| 位置 | `skills/<name>/` (monorepo) | `~/.claude/skills/<name>/` (Agent home) |

### 任务

**8.1 Skill 模板**
- 在 `workspace-template/.claude/skills/` 放一个 `SKILL_TEMPLATE.md`
- 描述两种 Skill 的标准结构
- Agent 按模板生成新 Skill

**8.2 通道 Skill 标准化**
- 定义通道 Skill 的最小接口：
  ```
  POST /send           — 接收出站消息
  POST /edit           — 编辑已发送消息 (Phase 5 新增)
  GET  /health         — 健康检查
  ```
- 所有通道 Skill 遵守此接口，Kernel 不感知具体平台

**8.3 Skill 安装流程（Agent 自主执行）**
- 用户: "帮我装个 Discord 通道"
- Agent:
  1. 在 `~/.claude/skills/discord/` 创建目录
  2. 写 `service.ts`（参考 Telegram Skill 的结构）
  3. 写 `SKILL.md`
  4. 写 `package.json`
  5. 安装依赖
  6. 向用户询问 bot token
  7. 写配置到 `~/.claude/config/discord.json`
  8. 通过 `start_skill_service` MCP 工具启动
  9. 验证注册成功

**8.4 工具 Skill 安装流程（更简单）**
- 用户: "帮我加个天气查询"
- Agent:
  1. 在 `~/.claude/skills/weather/` 写一个脚本
  2. 测试脚本能跑
  3. 记在记忆里："有天气查询 Skill，路径是 ~/.claude/skills/weather/query.ts"
  4. 之后需要天气信息时直接 `tsx ~/.claude/skills/weather/query.ts --city=Shanghai`

### 验证
- [ ] Agent 能按模板创建新通道 Skill
- [ ] Agent 能自主安装工具 Skill 并在后续对话中使用
- [ ] `list_skill_services` 正确反映运行中的通道 Skill

---

## Phase 9: 开源发布准备

### 目标
让非作者用户能在 15 分钟内跑起来。

### 任务

**9.1 CLI 工具**
- `codeclaw init` — 初始化配置和 workspace
- `codeclaw start` — 启动 Kernel + Agent 容器
- `codeclaw stop` — 优雅停止
- `codeclaw logs` — 查看 Agent 日志
- `codeclaw status` — 系统状态总览

**9.2 一键启动**
- `docker-compose.yml`：Kernel + Agent + 持久化卷
- 或 `codeclaw start` 一条命令搞定

**9.3 文档**
- README.md: 30 秒看懂是什么、5 分钟装好
- 架构文档: 给想贡献的人看
- Skill 开发指南: 如何写通道 Skill 和工具 Skill

**9.4 代码清理**
- 移除硬编码的代理地址和 API key
- 配置模板化（`.env.example`）
- GitHub Actions CI: lint + type-check

---

## 远期方向（不排期）

按需启动，不预先规划：

- **多 Agent 实例**：多个独立容器，各有人格和记忆
- **Agent 间通信**：Agent A 请求 Agent B 协助
- **人格 Skill**：种子人格生成（Big Five / MBTI），可选安装
- **分层模型路由**：简单问题用 Haiku，复杂任务用 Opus（参考 TinyClaw Smart Router）
- **定时任务**：Agent 自行安排 cron（proactive behavior）
- **多通道 Skill**：Discord, Slack, Web UI, CLI
- **语音**：TTS/STT 集成
- **Skill 市场**：标准化 Skill 包格式，社区分享

---

## 技术决策记录

| 决策 | 选择 | 理由 | 阶段 |
|------|------|------|------|
| 内核语言 | TypeScript ESM | 与 SDK 生态一致，类型安全 | Phase 0 |
| 内核 ↔ 容器通信 | HTTP | 简单、可调试、跨语言 | Phase 1 |
| 容器运行时 | Docker (Colima on macOS) | 成熟、跨平台 | Phase 1 |
| 消息队列 | 内存优先级队列 | 个人系统规模小，不需要 Redis | Phase 1 |
| SDK 使用模式 | Streaming Input | 长驻进程，避免 12s/次启动开销 | Phase 2 |
| Agent 三层模式 | SDK → chat → stub | 优雅降级，无 SDK 时仍可用 | Phase 2 |
| Double-send guard | 闭包 flag | 防止 MCP send + fallback result 重复发送 | Phase 2 |
| 非 root 容器 | `codeclaw` 用户 | SDK bypassPermissions 拒绝 root | Phase 2 |
| 第一个通道 | Telegram (grammy) | 库成熟，长轮询模式简单 | Phase 3 |
| 图片处理 | base64 + magic bytes | 绕过不可靠的 Content-Type header | Phase 3 |
| 进度展示 | Telegram editMessageText | 流式思考链，Code-first UX | Phase 5 |
| 安全模型 | Docker 隔离 + 白名单 + Emoji 审批 | 三层防御，渐进式 | Phase 6 |
| Agent 记忆 | SQLite FTS5 | 轻量、无外部依赖、全文检索 | Phase 7 |
| Skill 安装 | Agent 自己写代码 | 对 Claude Code Agent 最自然的方式 | Phase 8 |

---

## 里程碑

| 里程碑 | 阶段 | 状态 | 验证方式 |
|--------|------|------|---------|
| M1: 内核 HTTP API | Phase 1 | ✅ | curl 收发消息 |
| M2: Agent 容器通信 | Phase 2 | ✅ | 容器启动 + 轮询内核 |
| M3: Agent 回复消息 | Phase 2 | ✅ | Claude API 对话 |
| M4: Telegram 端到端 | Phase 4 | ✅ | TG → Agent → TG 全链路 |
| M5: SDK Agent 模式 | Phase 4 | ✅ | SDK query() + MCP tools |
| M6: Telegram 多媒体 | Phase 4 | ✅ | 图片/贴纸 → Claude Vision |
| M7: 群聊 @过滤 | Phase 4 | ✅ | 群聊仅 @bot 时响应 |
| M8: 思考链流式 | Phase 5 | 🔲 | Telegram 消息实时更新工具调用 |
| M9: Emoji 审批 | Phase 6 | 🔲 | 👍 批准危险操作 |
| M10: 持久记忆 | Phase 7 | 🔲 | 跨会话记住用户偏好 |
| M11: Skill 自安装 | Phase 8 | 🔲 | "装个天气查询" → Agent 自己完成 |
| M12: 一键启动 | Phase 9 | 🔲 | `codeclaw start` 15 分钟跑起来 |
