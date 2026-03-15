# CodeClaw 模块设计

> 顶层代码架构与模块职责。设计哲学见 architecture.md，具体实施计划见 plans/ 目录。

---

## 仓库结构

```
codeclaw/
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml             # packages/* + skills/*
├── tsconfig.json                   # 共享 TS 配置
├── codeclaw.yaml                   # 内核配置 (port: 19000, image: dev)
├── packages/
│   ├── types/src/                  # 共享类型
│   │   ├── messages.ts             # InboundMessage, OutboundMessage (含 editMessageId, progress)
│   │   ├── skill-service.ts        # SkillServiceRegistration (含 channel? 字段)
│   │   └── kernel-api.ts           # KernelAPI, QueueStatus, AgentHealthReport
│   ├── kernel/src/                 # 内核进程 (host 运行)
│   │   ├── index.ts                # 入口，组装各子系统
│   │   ├── http-server.ts          # HTTP API (port 19000), 全部路由, 出站透传 Skill 响应
│   │   ├── message-queue.ts        # 优先队列 + Map<key,timestamp> 去重
│   │   ├── io-bridge.ts            # Skill 注册 + channel→skillId 索引 + 出站路由
│   │   ├── container-manager.ts    # dockerode, Colima socket 自动检测
│   │   ├── agent-supervisor.ts     # 健康检查 + 崩溃检测 + 自动重启
│   │   ├── config.ts               # 加载 codeclaw.yaml
│   │   └── logger.ts               # pino
│   └── agent-runtime/              # Agent 容器内运行
│       ├── Dockerfile.dev          # Node 22 + USTC mirror + npmmirror + 非 root 用户
│       ├── package.json
│       └── src/
│           ├── index.ts            # 容器入口, 组装 + 信号处理
│           ├── agent-loop.ts       # 核心: SDK/chat/stub 三层模式 (channel-agnostic)
│           ├── kernel-client.ts    # HTTP 客户端 (GET/POST kernel API, 返回 messageId)
│           ├── message-injector.ts # 轮询内核 + waitForMessage()
│           ├── skill-service-manager.ts  # 子进程 Skill 生命周期 + getEndpoint()
│           └── logger.ts
├── skills/
│   └── telegram/
│       ├── service.ts              # grammy bot + 10 HTTP 端点 + JSONL 持久化
│       ├── mcp-server.ts           # stdio MCP server (8 工具, 自带 Kernel HTTP client)
│       ├── manifest.json           # Skill 清单 (含 mcpEntrypoint)
│       ├── package.json            # grammy + undici + @modelcontextprotocol/sdk
│       ├── SKILL.md                # Agent 可读操作手册
│       └── config.schema.json
└── workspace-template/
    ├── CLAUDE.md                   # Agent 自我认知文件 (L0 常驻层)
    └── config/
        └── telegram.json.example
```

---

## 模块职责

### Kernel (packages/kernel/)

内核是宿主机上的持久进程，职责是**消息路由与容器监督**，不参与任何业务逻辑。

- **index.ts**: 系统入口，按依赖顺序组装各子系统，监听 SIGINT/SIGTERM 优雅停机。
- **http-server.ts**: 对外暴露 HTTP API（默认端口 19000），处理全部路由；出站消息完整透传 Skill 的响应体（含 messageId）给 Agent。
- **message-queue.ts**: 内存优先级队列，以 Map 做 O(1) 去重，防止 Skill 重复投递同一消息；个人系统规模无需 Redis。
- **io-bridge.ts**: 维护 skillId → 服务注册信息的内存索引，以及 channel → skillId 的路由表；出站时根据 OutboundMessage 是否带 editMessageId 决定转发到 Skill 的 /send 或 /edit 端点。
- **container-manager.ts**: 封装 dockerode，自动检测 Colima socket 路径；负责容器的创建、启停、状态查询。
- **agent-supervisor.ts**: 定期 HTTP 健康检查 Agent 容器，崩溃时触发自动重启，并在重启后传递最后的 sessionId 以支持 resume。
- **config.ts**: 从 codeclaw.yaml 加载内核和 Agent 容器配置，类型安全，无运行时修改。

### Agent Runtime (packages/agent-runtime/)

Agent Runtime 运行在 Docker 容器内，职责是**驱动 Claude Agent 并与内核通信**。它是纯粹的执行层，不解析 Telegram 等平台细节。

- **index.ts**: 容器入口，启动 SkillServiceManager，扫描 `manifest.json` 中的 `mcpEntrypoint` 组装 `McpStdioServerConfig`，传给 agent-loop，注册信号处理器。
- **agent-loop.ts**: 系统核心。实现 SDK/chat/stub 三层模式（见下文）。Channel-agnostic，不包含任何 typing/progress 逻辑——仅通过 `reportHealth(busy/idle)` 附带 `conversation` 字段上报状态。MCP 工具通过 stdio 外部进程提供，Runtime 本身不持有任何工具定义。
- **kernel-client.ts**: 封装所有对内核 HTTP API 的调用，`sendMessage` 返回 `{ messageId? }` 供进度消息编辑使用。
- **message-injector.ts**: 周期性轮询内核 `/api/messages/next`，通过 Promise resolve 机制将消息桥接为 `AsyncIterable<SDKUserMessage>`，null sentinel 关闭 stream。
- **skill-service-manager.ts**: 扫描 `~/.claude/skills/*/manifest.json`，spawn Skill 子进程，动态分配端口，提供 `getEndpoint(skillId)` 供 agent-loop 直连 Skill（仅用于 chat action，不经 Kernel）。

### Types (packages/types/)

三个包共用的类型定义，是跨边界通信的"合同"。

- **messages.ts**: InboundMessage（channel/sender/conversation/content/timestamp）、OutboundMessage（含可选的 editMessageId 和 progress 标记）、MessageContent（文本/图片/音频/文件）。
- **skill-service.ts**: SkillServiceRegistration，描述 Skill 的 skillId、类型、能力列表、endpoint、以及可选的 channel 字段用于路由。
- **kernel-api.ts**: KernelAPI 接口、QueueStatus、AgentHealthReport，作为类型文档，不含运行时实现。

### Telegram Skill (skills/telegram/)

Telegram Skill 是一个自包含的独立进程，职责是**桥接 Telegram 平台与内核协议**。

- **service.ts**: 启动 Grammy bot 长轮询；向内核注册自身；对入站消息做平台层预处理（@提及过滤、图片/贴纸下载与 base64 编码、引用消息提取）后转发给内核；提供 9 个 HTTP 端点供内核或 Agent 直连调用；以 JSONL 格式按日期目录持久化聊天记录，含 seq ID 内存索引。Telegram API 访问通过 undici ProxyAgent + Grammy transformer 走 HTTP 代理。
- **mcp-server.ts**: 遵循 Claude Code Plugin 标准的 stdio MCP server。使用 `@modelcontextprotocol/sdk` 的 `StdioServerTransport`，由 SDK 作为子进程启动。包含 9 个工具（send_message、react_message、edit_message、delete_message、send_sticker、get_sticker_set、send_poll、get_message、show_progress），自带 Kernel HTTP client，不依赖 agent-runtime。同时负责两层反馈（见下文）：轮询 Kernel health 自动发送 typing，管理 show_progress 工具的进度消息生命周期。工具命名空间为 `mcp__telegram__*`。
- **SKILL.md**: 遵循 Agent Skills 开放标准（YAML frontmatter）。frontmatter 的 name/description 由 SDK 自动注入系统提示的 `<available_skills>` 索引（L1 层，约 24 tokens），body 是 Agent 按需 read 的操作手册，包含 MCP 工具用法、JSONL 数据格式、消息引用格式、群聊规则（L2 层）。

---

## 关键数据流

### 入站消息（用户 → Agent）

Telegram 消息经 Grammy bot 接收，做平台预处理（媒体下载、群聊过滤）后 POST 到内核 `/api/messages/inbound`，内核将其入优先队列。Agent Runtime 的 MessageInjector 轮询 `/api/messages/next`，通过 AsyncIterable 桥接为 SDK 的 Streaming Input，驱动 Agent 处理。

### 出站消息（Agent → 用户）

Agent 调用 MCP 工具（如 `mcp__telegram__send_message`）→ stdio MCP server 进程内的 Kernel HTTP client POST `/api/messages/outbound` → IOBridge 按 channel 查路由表 → 转发到 Skill 对应端点（/send 或 /edit）→ Skill 调用 Telegram API 发送，返回 messageId 沿原路径透传回 Agent。

### Skill 生命周期

容器启动后，SkillServiceManager 扫描 `~/.claude/skills/*/manifest.json`，spawn Skill 子进程并分配端口。Skill 进程启动后自行向内核 `/api/services/register` 注册，IOBridge 建立路由。同时，index.ts 扫描 manifest 中的 `mcpEntrypoint` 字段，组装 `McpStdioServerConfig` 传给 SDK query()，SDK 在初始化时自动启动 MCP server 子进程并建立 stdio JSON-RPC 连接。

---

## Agent Loop 三层模式

**SDK 模式**（最高优先）：使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` API，提供完整 Claude Code 工具集（Bash/Read/Write/Edit/Glob/Grep 等）加 Skill 提供的 stdio MCP 工具（如 Telegram 的 8 个工具，命名空间 `mcp__telegram__*`）。MCP server 作为独立子进程运行，遵循 Claude Code Plugin 标准。通过 `persistSession: true` 支持跨重启的 session resume，`bypassPermissions` 模式运行（要求非 root 用户）。

**Chat 模式**（降级方案）：SDK 不可用时，使用 `@anthropic-ai/sdk` 的 Messages API 进行纯文字对话，保留最近 50 条历史，支持自定义 base_url 和 HTTP 代理，含 3 次指数退避重试。

**Stub 模式**（兜底）：无 API key 时的回显模式，用于开发调试，保证系统在无凭证情况下仍可启动。

模式选择逻辑：SDK 可用且有 API key → SDK；SDK 不可用但有 API key → chat；无 API key → stub。

---

## 两层反馈模型

agent-loop 是 channel-agnostic 的，仅通过 `reportHealth(busy/idle)` 上报状态（含 `conversation` 字段标识当前处理的会话）。所有 typing/progress 逻辑由 MCP server（Skill 侧）负责。

**Layer 1 — Typing（自动，零 token）**：MCP server 每 5 秒轮询 Kernel `GET /api/agent/health`，检测 agent 状态为 `busy` 且 `conversation` 属于 telegram 时，POST 到 Skill `/action` 发送 typing。Layer 2 激活时自动跳过 typing，避免频率限制冲突。

**Layer 2 — Progress（Agent 主动，零 token）**：Agent 在长程任务中调用 `show_progress` MCP 工具展示/更新/关闭进度消息。进度消息带 `progress: true` 标记，Skill 侧跳过 JSONL 写入。Agent 完成任务时可调用 `show_progress(active: false)` 与 `send_message` 并行执行。

**安全网**：MCP server 的 typing 轮询检测到 `idle`/`alive` 状态时，自动清理残留的 progress 消息，防止 /interrupt 或崩溃后遗留。

---

## Kernel HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/messages/inbound | Skill → 内核，投递入站消息 |
| POST | /api/messages/outbound | Agent → 内核 → Skill，出站消息（透传 Skill 响应含 messageId） |
| GET | /api/messages/next | Agent 轮询下一条消息 |
| GET | /api/messages/queue | 队列状态查询 |
| POST | /api/services/register | Skill 注册 |
| POST | /api/services/unregister | Skill 注销 |
| POST | /api/agent/health | Agent 健康上报（含 conversation 字段） |
| GET | /api/agent/health | Agent 健康状态查询（MCP server 轮询用） |
| GET | /api/status | 内核总体状态 |

## Telegram Skill HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /send | 发送消息（支持 progress 标记跳过 JSONL，返回 messageId + seq） |
| POST | /edit | 编辑已发送消息（不写 JSONL） |
| POST | /action | 发送 chat action（如 typing，含 401 熔断器保护） |
| POST | /react | 添加/移除 Emoji 反应 |
| POST | /delete | 删除消息 |
| POST | /sticker | 发送贴纸（写 JSONL，返回 messageId） |
| POST | /sticker_set | 获取贴纸包（分页，thumbnail base64，limit 上限 20） |
| POST | /poll | 创建投票（返回 messageId + pollId） |
| POST | /get_message | 查询历史消息（按 seq O(1) 或 messageId 扫描，含 attachments） |

---

## 技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 内核语言 | TypeScript ESM | 与 SDK 生态一致，类型安全 |
| 内核 ↔ 容器通信 | HTTP | 简单、可调试、跨语言 |
| 容器运行时 | Docker (Colima on macOS) | 成熟、跨平台 |
| 消息队列 | 内存优先级队列 | 个人系统规模小，不需要 Redis |
| SDK 使用模式 | Streaming Input (query()) | 长驻进程，避免每次 12s 启动开销 |
| Agent 三层模式 | SDK → chat → stub | 优雅降级，无 SDK 时仍可用 |
| MCP 工具架构 | stdio 子进程 (Plugin 标准) | Skill 自包含 MCP server，Runtime 不持有工具定义 |
| 非 root 容器 | codeclaw 用户 | SDK bypassPermissions 拒绝 root |
| 第一个通道 | Telegram (grammy) | 库成熟，长轮询模式简单 |
| 图片处理 | base64 + magic bytes 检测 | 绕过不可靠的 Content-Type header |
| SKILL.md 格式 | Agent Skills 开放标准 (YAML frontmatter) | SDK 内置渐进式披露：元数据索引 → Agent 按需 read |
| 反馈模型 | MCP server 轮询 Kernel health | agent-loop channel-agnostic，Skill 侧自治 |
| 安全模型 | Docker 隔离 + 白名单 + Emoji 审批 | 三层防御，渐进式 |
| Agent 记忆 | SQLite FTS5 | 轻量、无外部依赖、全文检索 |
| Skill 安装 | Agent 自己写代码 | 对 Claude Code Agent 最自然的方式 |

---

## 远期方向

按需启动，不预先规划：

- **多 Agent 实例**：多个独立容器，各有人格和记忆
- **Agent 间通信**：Agent A 请求 Agent B 协助
- **人格 Skill**：种子人格生成（Big Five / MBTI），可选安装
- **分层模型路由**：简单问题用 Haiku，复杂任务用 Opus
- **定时任务**：Agent 自行安排 cron（proactive behavior）
- **多通道 Skill**：Discord、Slack、Web UI、CLI
- **语音**：TTS/STT 集成
- **Skill 市场**：标准化 Skill 包格式，社区分享
