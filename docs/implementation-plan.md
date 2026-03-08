# CodeClaw 实施计划

> 基于 V2 设计哲学文档，定义从零到可用的最小实现路径。
> 目标：一个可运行的最小系统——内核 + 一个 Agent 容器 + Telegram 通道 Skill。

---

## 阶段概览

```
Phase 0: 项目脚手架                    [预计 1 天]
Phase 1: 最小内核                      [预计 3-5 天]
Phase 2: Agent 容器运行时              [预计 2-3 天]
Phase 3: 第一个通道 Skill (Telegram)   [预计 2-3 天]
Phase 4: 端到端联调                    [预计 1-2 天]
Phase 5: 迭代完善                      [持续]
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
    cwd: "/workspace",
    resume: lastSessionId,          // 崩溃恢复
    systemPrompt: { type: "preset", preset: "claude_code" },
    allowedTools: [
      "Bash", "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch", "Agent",
      "mcp__codeclaw__*"
    ],
    permissionMode: "bypassPermissions",
    settingSources: ["project"],     // 读取 workspace/CLAUDE.md
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
- /workspace 是你的家目录，所有文件在重启后保留
- 你通过 MCP 工具 (codeclaw) 与外界通信

## 目录结构
- memory/          — 你的长期记忆 (knowledge.db 是 SQLite FTS5)
- skills/          — 已安装的 Skills，每个有 MANUAL.md
- config/          — 配置文件
- scratch/         — 临时文件
- .claude/         — SDK session 数据 (自动管理)

## 如何与用户通信
- 使用 send_message 工具发送消息
- 使用 get_queue_status 查看待处理消息
- 新消息会在你的工具调用间隙自动通知你

## 如何管理 Skills
- 查看已安装 Skills: ls skills/
- 阅读 Skill 说明: cat skills/<name>/MANUAL.md
- 启动 Skill 服务: 使用 start_skill_service 工具
- Skill 配置写在 config/<skill-name>.json

## 记忆管理
- 重要的事实和偏好 → 写入 memory/knowledge.db
- 长篇笔记和总结 → 写入 memory/ 下的 .md 文件
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
skills/telegram/
├── MANUAL.md              # Agent 读的说明书
├── service.ts             # Telegram Bot 服务
├── config.schema.json     # 配置 schema
├── package.json           # 依赖 (grammy)
└── tsconfig.json
```

### 任务

**3.1 MANUAL.md**

```markdown
# Telegram 通道 Skill

## 功能
收发 Telegram 消息。安装后，你可以通过 Telegram Bot 与用户对话。

## 安装步骤
1. 确保 config/telegram.json 存在且包含 bot_token
2. 安装依赖: cd skills/telegram && npm install
3. 启动服务: 使用 start_skill_service 工具
   - skillId: "telegram"
   - command: "node"
   - args: ["skills/telegram/service.js"]

## 配置 (config/telegram.json)
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

const config = JSON.parse(fs.readFileSync("/workspace/config/telegram.json"));
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
#    agent 读 MANUAL.md → 要求用户提供 bot_token → 写配置 → 启动服务
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

## Phase 5: 迭代完善

Phase 4 跑通后，按优先级迭代：

### 5.1 近期（P0）
- **CLI 管理工具**：`codeclaw start`, `codeclaw stop`, `codeclaw logs`, `codeclaw status`
- **错误处理加固**：内核/Agent/Skill 各层的异常处理和日志
- **消息间隙注入**：Agent 处理长任务时，新消息的系统通知插入
- **Skill 安装体验**：通过自然语言告诉 agent "安装 Telegram"

### 5.2 中期（P1）
- **Web UI Skill**：简单的网页聊天界面
- **分层模型**：简单消息用 Haiku，复杂任务用用户选择的主模型
- **SQLite FTS5 记忆**：Agent 可存取结构化记忆
- **定时任务**：Agent 可自行安排 cron 任务（内核或 Skill 层实现）
- **多 Skill 通道**：Discord, Slack 等

### 5.3 远期（P2）
- **多 Agent 实例**：多个独立容器，各有自己的人格和记忆
- **Agent 间通信**：Agent A 可以请求 Agent B 协助
- **Skill 市场**：标准化的 Skill 包格式，可分享/安装
- **移动端通道**：iOS/Android 原生 app
- **语音**：TTS/STT 集成

---

## 技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 内核语言 | TypeScript | 与 SDK 生态一致，类型安全 |
| 内核 ↔ 容器通信 | HTTP | 简单、可调试、跨语言；后续可切换 Unix Socket |
| 容器运行时 | Docker | 成熟、跨平台；未来可支持 Podman |
| 消息队列 | 内存 (TypeScript Map/Array) | 个人系统规模小，不需要 Redis |
| 持久化 | Docker Volume | 简单、容器重启不丢数据 |
| SDK 使用模式 | Streaming Input | 长驻进程，避免 12s/次的启动开销 |
| Session 存储 | SDK 原生 JSONL | 不对抗框架，resume 直接可用 |
| Agent 侧数据库 | SQLite | 轻量、无外部依赖、FTS5 够用 |
| 第一个通道 | Telegram | grammy 库成熟，Webhook 模式简单 |
| 安全模型 | Docker 容器隔离 | 容器即沙箱，不需要 Bash 白名单 |

---

## 风险和缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| SDK Streaming Input 不稳定 | 低 | 高 | 降级到 per-message query() + session resume |
| Docker 容器网络配置复杂 | 中 | 中 | Phase 0 先验证网络连通性 |
| Agent 首次响应慢 (12s) | 确定 | 中 | Streaming Input 避免重复启动；首条消息可提示"正在启动" |
| Skill 服务崩溃 | 中 | 中 | 内核进程监督自动重启 |
| 长期运行内存泄漏 | 中 | 中 | 定期健康检查 + 容器自动重启策略 |
| CLAUDE.md 复杂度增长 | 低 | 高 | 严格控制核心内容 <200 行，Skill 知识在 MANUAL.md |

---

## 最小可验证里程碑

**M1: 内核能收发 HTTP 消息**（Phase 1 完成）
- 用 curl 发消息到内核 → 队列入队 → 查询队列 → 消息在

**M2: Agent 容器能启动并与内核通信**（Phase 2 完成）
- 容器启动 → Agent 进程运行 → 通过 MCP 调用内核 API → 成功

**M3: Agent 能回复通过 curl 发送的消息**（Phase 2+3 部分）
- curl 发消息到内核 → Agent 收到 → Agent 回复 → 内核有出站消息

**M4: Telegram 端到端**（Phase 4 完成）
- Telegram 发消息 → Bot 收到 → 内核 → Agent → 回复 → Telegram 显示
