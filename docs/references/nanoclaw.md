# NanoClaw 项目深度分析

> 最后更新：2026-03-08
> 源码位置：`/Users/zhaoqixuan/Projects/CodeClaw/nanoclaw/`

---

## 一、项目概览

NanoClaw 是一个**轻量级、安全隔离的个人 Claude 助手系统**，通过 Docker 容器化运行 AI Agent，支持多通道消息处理。

**核心数据**：
- 源码语言：TypeScript (ESM)
- 核心代码量：约 6,915 行
- 容器运行时：Docker（可切换 Apple Container）
- AI 引擎：Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- 数据库：SQLite (better-sqlite3)
- 测试框架：Vitest

**设计哲学**：
> "Small enough to understand. Secure by isolation. Built for the individual user."

与 OpenClaw（约 50 万行代码）相比，NanoClaw 刻意保持极简——所有核心逻辑对一个开发者完全可审计。功能扩展不通过增加核心代码，而是通过 Claude Code Skills 修改源码实现。

---

## 二、核心架构

### 2.1 数据流总览

```
消息通道 (WhatsApp/Telegram/Slack/Discord/Gmail)
    ↓ onMessage 回调
SQLite 数据库 (消息存储、群组管理、任务调度)
    ↓ 2 秒轮询
消息循环 (src/index.ts - Orchestrator)
    ↓ 检查触发词 + 排队
Group Queue (per-group 并发控制, 最多 5 容器)
    ↓ 生成容器 or 管道复用
Container Runner (Docker 隔离容器)
    ↓ stdin JSON / stdout 标记
Agent Runner (Claude Agent SDK query())
    ↓ AI 推理结果
响应路由 → 去除 <internal> 标签 → 通道投递 → 用户
```

### 2.2 核心组件一览

| 组件 | 文件 | 行数 | 职责 |
|------|------|------|------|
| **Orchestrator** | `src/index.ts` | ~589 | 主进程协调器，状态管理，轮询循环 |
| **Channel Registry** | `src/channels/registry.ts` + `index.ts` | - | 通道工厂注册，自注册模式 |
| **SQLite DB** | `src/db.ts` | ~698 | 消息/聊天/任务/会话/群组的持久化 |
| **Router** | `src/router.ts` | - | 消息格式化为 XML，通道查找，输出过滤 |
| **Group Queue** | `src/group-queue.ts` | - | per-group 状态机 + 并发控制 + 管道复用 |
| **Container Runner** | `src/container-runner.ts` | ~500+ | 容器生成、挂载管理、stdin/stdout 通信 |
| **Task Scheduler** | `src/task-scheduler.ts` | ~200+ | cron/interval/once 三种调度 |
| **IPC Watcher** | `src/ipc.ts` | ~300+ | 文件系统 IPC 轮询 + 权限检查 |
| **Container Runtime** | `src/container-runtime.ts` | - | Docker/Apple Container 运行时抽象 |
| **Config** | `src/config.ts` | - | 常量：触发模式、超时、路径、并发限制 |
| **Types** | `src/types.ts` | - | TypeScript 接口定义 |
| **Group Folder** | `src/group-folder.ts` | - | 群组目录验证（防路径穿越） |
| **Mount Security** | `src/mount-security.ts` | - | 挂载白名单验证 |
| **Sender Allowlist** | `src/sender-allowlist.ts` | - | per-chat 发送者过滤 |
| **Env** | `src/env.ts` | - | 受控环境变量读取 |

---

## 三、Orchestrator 详解（src/index.ts）

Orchestrator 是整个系统的主循环，管理所有子系统。

### 3.1 状态管理

```typescript
// 核心状态
sessions: Map<groupFolder, sessionId>        // 群组 → Claude 会话 ID
registeredGroups: Map<groupFolder, GroupConfig> // 群组注册信息
lastAgentTimestamp: Map<groupFolder, timestamp> // 上次 Agent 交互时间
lastProcessedTimestamp: Map<jid, timestamp>     // 上次处理的消息时间
```

### 3.2 主循环逻辑（每 2 秒）

```
1. 遍历所有已注册群组
2. 对每个群组：
   a. 获取 lastAgentTimestamp 之后的新消息
   b. 检查是否存在触发词（@AssistantName）
   c. 非主群组：必须有触发词（除非 requiresTrigger: false）
   d. 有新消息且被触发 → 加入 Group Queue
3. Group Queue 按并发限制处理
```

### 3.3 启动流程

```
1. 初始化 SQLite 数据库 + 自动迁移
2. 加载状态（sessions, registeredGroups, lastProcessedTimestamp）
3. 连接所有已配置的通道
4. 启动消息轮询循环（2 秒间隔）
5. 启动 IPC Watcher
6. 启动 Task Scheduler
7. 清理上次运行的孤儿容器
```

### 3.4 优雅关闭

收到 SIGTERM/SIGINT 时：
- 停止轮询循环
- 断开所有通道
- 关闭所有活跃容器
- 保存状态到数据库
- 关闭 SQLite 连接

---

## 四、通道系统（src/channels/）

### 4.1 统一接口

```typescript
interface Channel {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  ownsJid(jid: string): boolean;
  isConnected(): boolean;
  // 可选
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(): Promise<Group[]>;
}
```

### 4.2 工厂注册模式

通道通过工厂函数自注册：
- 工厂函数检查凭证是否存在
- 凭证不存在 → 返回 `null`（优雅跳过）
- 凭证存在 → 返回 Channel 实例

通过 barrel imports 在模块加载时完成注册，无需手动配置。

### 4.3 已支持通道

通过 Claude Code Skills 安装：
- **WhatsApp** (`/add-whatsapp`)
- **Telegram** (`/add-telegram`)
- **Slack** (`/add-slack`)
- **Discord** (`/add-discord`)
- **Gmail** (`/add-gmail`)

每个通道 Skill 会修改源码以添加对应的通道实现。

---

## 五、数据库设计（src/db.ts）

### 5.1 Schema

```sql
-- 消息记录
messages (
  id INTEGER PRIMARY KEY,
  jid TEXT,           -- 聊天标识符
  sender TEXT,        -- 发送者名称
  text TEXT,          -- 消息内容
  timestamp INTEGER,  -- 时间戳（索引）
  is_from_me BOOLEAN  -- 是否是 Agent 发出
)

-- 聊天元数据
chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_activity INTEGER
)

-- 定时任务
scheduled_tasks (
  id TEXT PRIMARY KEY,
  chat_jid TEXT,
  group_folder TEXT,
  prompt TEXT,
  schedule_type TEXT,   -- 'cron' | 'interval' | 'once'
  schedule_value TEXT,
  next_run INTEGER,
  last_run INTEGER,
  last_result TEXT,
  status TEXT,          -- 'active' | 'paused' | 'completed'
  created_at INTEGER
)

-- 任务执行日志
task_run_logs (
  id INTEGER PRIMARY KEY,
  task_id TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  result TEXT,
  status TEXT
)

-- Claude 会话映射
sessions (
  group_folder TEXT PRIMARY KEY,
  session_id TEXT
)

-- 已注册群组
registered_groups (
  folder TEXT PRIMARY KEY,
  name TEXT,
  trigger TEXT,
  added_at TEXT,
  is_main BOOLEAN,
  requires_trigger BOOLEAN,
  container_config TEXT  -- JSON
)

-- 路由状态
router_state (
  key TEXT PRIMARY KEY,
  value TEXT
)
```

### 5.2 特性

- 自动从 legacy JSON 文件迁移
- 消息按 timestamp 索引加速查询
- 原子事务保证一致性

---

## 六、Group Queue 详解（src/group-queue.ts）

### 6.1 设计目标

解决并发控制问题：多个群组同时收到消息时，不能无限制 spawn 容器。

### 6.2 状态机

每个群组有四种状态：

```
                    新消息到达
                       │
         ┌─────────────▼─────────────┐
         │      pendingMessages      │
         │  (消息排队，等待处理)       │
         └─────────────┬─────────────┘
                       │ 获得并发槽位
         ┌─────────────▼─────────────┐
         │         active            │
         │  (容器运行中，处理消息)     │
         └──┬──────────┬─────────────┘
            │          │ 处理完成
            │    ┌─────▼─────────────┐
            │    │    idleWaiting    │
            │    │  (容器空闲等待)    │
            │    └─────┬─────────────┘
            │          │ 超时 or 新消息
            │          │
         ┌──▼──────────▼─────────────┐
         │      pendingTasks         │
         │  (定时任务排队)            │
         └───────────────────────────┘
```

### 6.3 管道复用（Piping）

当容器处于 `idleWaiting` 状态，新消息到达时：
- **不需要** spawn 新容器
- 直接通过 **stdin 管道** 发送新消息到已有容器
- 避免了容器启动开销

### 6.4 重试策略

- 最多 5 次重试
- 指数退避：5s → 10s → 20s → 40s → 80s

### 6.5 并发控制

- 全局最大并发容器数：5（通过 `MAX_CONCURRENT_CONTAINERS` 环境变量配置）
- 使用信号量（semaphore）控制

---

## 七、Container Runner 详解（src/container-runner.ts）

### 7.1 容器挂载策略

**主群组（isMain=true）**：
```
/workspace/group → groups/{folder}/     (rw，群组工作目录)
/workspace/global → 项目根目录          (ro，只读)
/workspace/ipc → data/ipc/{folder}/     (rw，IPC 目录)
.claude/ → data/sessions/{folder}/.claude/ (rw)
```

**非主群组**：
```
/workspace/group → groups/{folder}/     (rw)
/workspace/global → groups/             (ro，全局记忆只读)
/workspace/ipc → data/ipc/{folder}/     (rw)
.claude/ → data/sessions/{folder}/.claude/ (rw)
```

**额外挂载**：通过 `containerConfig.additionalMounts` 配置，需经过 `mount-allowlist.json` 白名单验证。

### 7.2 输入/输出协议

**输入（stdin JSON）**：
```json
{
  "prompt": "<context timezone='...' /><messages>...</messages>",
  "sessionId": "uuid-xxx",
  "groupFolder": "telegram_dev-team",
  "isMain": false,
  "isScheduledTask": false,
  "assistantName": "Andy"
}
```

**输出（stdout 标记）**：
```
---NANOCLAW_OUTPUT_START---
Agent 的回复文本
---NANOCLAW_OUTPUT_END---
```

### 7.3 空闲超时

容器空闲超过 30 分钟（`IDLE_TIMEOUT`）后自动关闭 stdin 并销毁容器。

---

## 八、容器内部运行时（container/）

### 8.1 Dockerfile

```dockerfile
FROM node:22-slim
# 安装 Chromium + 系统依赖（浏览器自动化）
# 安装 agent-browser 和 @anthropic-ai/claude-code
# 非 root 用户 (node)
# 工作目录: /workspace/group
```

### 8.2 Agent Runner（container/agent-runner/src/index.ts）

核心执行逻辑：

```typescript
1. 从 stdin 读取 JSON 配置
2. 创建 MessageStream（async iterable，轮询 IPC 输入文件）
3. 调用 Claude Agent SDK 的 query()：
   - userMessage: 初始消息 + 管道/IPC 后续消息
   - sessionId: 会话连续性
   - MCP Server: NanoClaw（调度、消息、群组管理）
4. 输出结果包装在标记中
5. 支持多结果流（agent swarm）
6. 轮询 /workspace/ipc/input/ 获取后续消息
7. 检测 /workspace/ipc/input/_close 哨兵文件
```

---

## 九、IPC 系统详解（src/ipc.ts）

### 9.1 通信机制

使用**文件系统**代替 socket/管道，简化容器间通信：

```
data/ipc/{group}/messages/{uuid}.json  → 发送消息
data/ipc/{group}/tasks/{uuid}.json     → 管理定时任务
data/ipc/{group}/input/{uuid}.json     → 后续输入（Host → Container）
data/ipc/{group}/input/_close          → 关闭哨兵
```

### 9.2 消息格式

```json
// 发送消息
{"type": "message", "chatJid": "xxx@g.us", "text": "Hello!"}

// 调度任务
{"type": "schedule_task", "chatJid": "xxx", "prompt": "每日汇报",
 "schedule_type": "cron", "schedule_value": "0 9 * * 1"}

// 更新/取消任务
{"type": "update_task", "taskId": "xxx", "action": "pause|resume|cancel"}
```

### 9.3 权限模型

| 操作 | 主群组 | 非主群组 |
|------|--------|----------|
| 发送消息到任意聊天 | ✅ | ❌（仅自己的聊天） |
| 为任意群组调度任务 | ✅ | ❌（仅自身群组） |

错误文件移至 `data/ipc/errors/` 供检查。

---

## 十、消息路由（src/router.ts）

### 10.1 消息格式化

将数据库消息格式化为 XML 提供给 Agent：

```xml
<context timezone="America/New_York" />
<messages>
  <message sender="John" time="Jan 31 2:32 PM">hey everyone, what's the plan?</message>
  <message sender="Sarah" time="Jan 31 2:33 PM">@Andy can you check the calendar?</message>
</messages>
```

### 10.2 输出处理

- 去除 `<internal>...</internal>` 标签（Agent 内部推理不发给用户）
- XML 特殊字符转义
- 通过 `channel.ownsJid(jid)` 查找消息归属通道

---

## 十一、定时任务（src/task-scheduler.ts）

### 11.1 三种调度模式

| 模式 | 示例 | 说明 |
|------|------|------|
| `cron` | `"0 9 * * 1"` | 每周一 9:00 |
| `interval` | `3600000` | 每小时（毫秒） |
| `once` | `"2024-02-01T09:00:00Z"` | 一次性 |

### 11.2 执行流程

```
1. 每 60 秒轮询 getDueTasks()
2. 任务到期时：
   a. 在群组上下文中 spawn 容器（isScheduledTask=true）
   b. 执行 Agent + 任务 prompt
   c. 计算下次执行时间（锚定到原定时间，防止漂移）
   d. 更新 next_run, last_run, last_result
   e. 记录到 task_run_logs
3. 无 next_run → 标记为 'completed'
```

---

## 十二、群组管理

### 12.1 目录结构

```
nanoclaw/
├── groups/
│   ├── CLAUDE.md                          # 全局记忆（所有群组只读，主群组可写）
│   ├── whatsapp_family-chat/
│   │   └── CLAUDE.md                      # 群组专属记忆
│   ├── telegram_dev-team/
│   │   └── CLAUDE.md
│   └── ...
├── data/
│   ├── sessions/{folder}/.claude/         # Claude 会话记录
│   └── ipc/{folder}/                      # IPC 文件
├── store/
│   └── messages.db                        # SQLite 数据库
└── ...
```

### 12.2 群组配置

```typescript
interface RegisteredGroup {
  name: string;              // "Family Chat"
  folder: string;            // "whatsapp_family-chat"
  trigger: string;           // "@Andy"
  added_at: string;          // ISO timestamp
  isMain?: boolean;          // 主控群组（不需要触发词）
  requiresTrigger?: boolean; // 默认 true（1-to-1 聊天为 false）
  containerConfig?: {
    additionalMounts: string[];
    timeout?: number;
  };
}
```

### 12.3 命名规则

群组目录命名：`{channel}_{group-name}`
- `whatsapp_family-chat`
- `telegram_dev-team`
- `discord_gaming-server`

---

## 十三、安全模型

### 13.1 多层防御

| 层 | 机制 | 说明 |
|----|------|------|
| **容器隔离** | Docker/Apple Container | OS 级别隔离，主安全边界 |
| **挂载安全** | `mount-allowlist.json` | 白名单存放在项目外部，永不被挂载 |
| **会话隔离** | 每群组独立 Session | 不同群组的 Agent 不共享会话 |
| **IPC 授权** | 身份验证 | 主群组 vs 非主群组的操作权限差异 |
| **凭证隔离** | `.env` 受控读取 | 只暴露指定的环境变量 |
| **非 root** | `node` 用户 | 容器内以非特权用户运行 |
| **只读挂载** | 项目根 ro | 主群组的项目挂载为只读 |
| **路径验证** | `group-folder.ts` | 防止路径穿越攻击 |
| **发送者过滤** | `sender-allowlist.ts` | per-chat 的 allow/deny 列表 |

### 13.2 白名单配置

```
~/.config/nanoclaw/mount-allowlist.json   # 额外挂载白名单
~/.config/nanoclaw/sender-allowlist.json  # 发送者过滤
```

这些文件存放在项目目录外，容器无法读取或修改。

---

## 十四、Skills 扩展系统

### 14.1 设计理念

NanoClaw 不通过插件 API 扩展，而是通过 **Claude Code Skills 直接修改源代码**。这保持了核心代码的简洁，但也意味着每次扩展都是源码变更。

### 14.2 可用 Skills

| Skill | 命令 | 功能 |
|-------|------|------|
| 初始安装 | `/setup` | 完整安装流程 |
| WhatsApp | `/add-whatsapp` | 添加 WhatsApp 通道 |
| Telegram | `/add-telegram` | 添加 Telegram 通道 |
| Slack | `/add-slack` | 添加 Slack 通道 |
| Discord | `/add-discord` | 添加 Discord 通道 |
| Gmail | `/add-gmail` | 添加 Gmail 通道 |
| 语音转录 | `/add-voice-transcription` | Whisper 集成 |
| 图像理解 | `/add-image-vision` | 图像处理 |
| 自定义 | `/customize` | 交互式定制 |
| 调试 | `/debug` | 故障排查 |
| 更新 | `/update-nanoclaw` | 拉取上游更新 |
| Apple Container | `/convert-to-apple-container` | 切换运行时 |
| 并行 Agent | `/add-parallel` | Agent Swarm 支持 |

### 14.3 Skill 执行方式

每个 Skill 位于 `.claude/skills/` 目录，包含指导 Claude Code 修改源码的指令。例如 `/add-telegram` 会：
1. 在 `src/channels/` 创建 Telegram 适配器
2. 在 barrel import 中注册
3. 更新 `.env.example` 添加 `TELEGRAM_BOT_TOKEN`
4. 修改 Dockerfile 添加必要依赖

---

## 十五、依赖清单

| 包 | 用途 |
|----|------|
| `better-sqlite3` | SQLite 数据库驱动 |
| `@anthropic-ai/claude-agent-sdk` | Claude Agent 编排 |
| `cron-parser` | Cron 表达式解析 |
| `pino` + `pino-pretty` | 结构化日志 |
| `yaml` | YAML 配置解析 |
| `zod` | 运行时类型验证 |
| `tsx` | TypeScript 执行（开发） |
| `typescript` | TypeScript 编译器 |
| `vitest` | 测试框架 |
| `prettier` | 代码格式化 |
| `husky` | Git hooks |

---

## 十六、配置与环境变量

NanoClaw **没有配置文件**，所有配置通过环境变量和代码常量完成：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ASSISTANT_NAME` | `"Andy"` | 触发词 |
| `ANTHROPIC_API_KEY` | - | Claude API 认证 |
| `CLAUDE_CODE_OAUTH_TOKEN` | - | Claude OAuth 认证 |
| `CONTAINER_TIMEOUT` | 30 min | Agent 执行超时 |
| `IDLE_TIMEOUT` | 30 min | 空闲容器存活时间 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | 最大并发容器数 |

---

## 十七、项目目录结构

```
nanoclaw/
├── src/                        # 主进程源码（~6,915 行）
│   ├── index.ts               # Orchestrator 核心
│   ├── channels/              # 通道注册 + 自注册
│   │   ├── registry.ts        # 工厂注册表
│   │   └── index.ts           # Barrel imports
│   ├── container-runner.ts    # 容器生成 + 管理
│   ├── container-runtime.ts   # Docker/Apple 运行时抽象
│   ├── db.ts                  # SQLite 操作
│   ├── group-queue.ts         # per-group 并发控制
│   ├── ipc.ts                 # IPC 文件监控
│   ├── router.ts              # 消息路由
│   ├── task-scheduler.ts      # 定时任务
│   ├── config.ts              # 常量配置
│   ├── types.ts               # 类型定义
│   ├── group-folder.ts        # 目录验证
│   ├── mount-security.ts      # 挂载安全
│   ├── sender-allowlist.ts    # 发送者过滤
│   ├── env.ts                 # 环境变量
│   └── logger.ts              # 日志
├── container/
│   ├── Dockerfile             # Agent 容器镜像
│   ├── agent-runner/          # 容器入口（Claude Agent SDK 封装）
│   │   └── src/index.ts       # 读 stdin → 调用 query() → 写 stdout
│   └── skills/                # 浏览器自动化 Skill
├── .claude/skills/            # Claude Code Skills（扩展功能）
├── groups/                    # per-group 对话记忆
│   ├── CLAUDE.md             # 全局记忆
│   └── {channel}_{name}/    # 群组目录
│       └── CLAUDE.md         # 群组记忆
├── store/
│   └── messages.db           # SQLite 数据库
├── data/
│   ├── sessions/             # Claude 会话
│   └── ipc/                  # IPC 文件
├── docs/                     # SPEC, SECURITY, 架构文档
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 十八、关键设计模式总结

| 模式 | 应用 |
|------|------|
| **工厂模式** | 通道注册：工厂返回 Channel 实例或 null |
| **自注册** | 通道通过 barrel imports 在模块加载时注册 |
| **文件系统 IPC** | 消除 socket 复杂性，天然适配容器 |
| **Skill 扩展** | 新功能通过 Claude Code Skills 修改源码 |
| **per-group 隔离** | 会话、挂载、执行上下文按群组隔离 |
| **游标轮询** | 基于时间戳追踪已处理消息，防止重复处理 |
| **管道复用** | 空闲容器接收新消息，避免重复启动 |
| **指数退避** | 失败重试时指数增长等待时间 |
| **信号量并发** | 全局容器数上限控制 |

---

## 十九、已知局限（来自设计哲学文档的分析）

1. **无状态容器**：每次消息可能 spawn 新容器，Agent 缺乏持续存在感
2. **改源码当配置**：所有定制通过 Claude Code 修改源代码，不可逆且有风险
3. **per-group 记忆隔离**：同一 Agent 在不同群组间不共享记忆（只有 CLAUDE.md 可读）
4. **轮询架构**：2 秒轮询 + 文件系统 IPC 是简单但不优雅的方案
5. **单一 AI 引擎**：绑定 Claude Agent SDK，无法切换其他 LLM 提供商
