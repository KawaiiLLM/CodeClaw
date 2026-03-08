# OpenClaw 项目深度分析

> 最后更新：2026-03-08
> 源码位置：`/Users/zhaoqixuan/Projects/CodeClaw/openclaw/`
> 仓库：https://github.com/openclaw/openclaw

---

## 一、项目概览

OpenClaw 是一个**多通道 AI 网关**（Multi-channel AI gateway），支持在各类消息平台上运行 AI 助手。它是目前最全面的开源个人 AI 助手基础设施。

**核心数据**：
- 源码语言：TypeScript (ESM) + Swift (macOS/iOS) + Kotlin (Android)
- 代码量：约 884,000 行 TypeScript，4,679 个 .ts 文件
- 版本：`2026.3.8`，MIT 许可
- 包管理：pnpm monorepo（pnpm-workspace.yaml）
- 运行时：Node.js 22+（也支持 Bun）
- 构建：tsdown + tsc
- 测试：Vitest（70% 覆盖率阈值）
- 格式化/Lint：Oxfmt + Oxlint

**设计理念**：
> "The AI that actually does things. It runs on your devices, in your channels, with your rules."

---

## 二、整体架构

### 2.1 分层架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                        用户接入层                                 │
│  CLI (Commander.js)  │  TUI (pi-tui)  │  Web UI (Lit)           │
│  macOS App (SwiftUI) │  iOS App (Swift)│  Android App (Kotlin)   │
│  ACP (Agent Client Protocol)                                     │
└───────────────────────────────┬──────────────────────────────────┘
                                │ WebSocket / HTTP / stdin
┌───────────────────────────────▼──────────────────────────────────┐
│                     Gateway 网关服务 (常驻守护进程)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Auth &   │ │ Protocol │ │ Config   │ │ Method Handlers   │   │
│  │ RBAC     │ │ (WS+HTTP)│ │ Reload   │ │ (65+ 模块)       │   │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Cron     │ │ Heartbeat│ │ Plugin   │ │ Channel Health    │   │
│  │ Service  │ │ Runner   │ │ Services │ │ Monitor           │   │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────────┘   │
└──┬──────────────┬──────────────┬──────────────┬──────────────────┘
   │              │              │               │
┌──▼────────┐ ┌──▼──────────┐ ┌▼────────────┐ ┌▼──────────────┐
│ 路由系统   │ │ Agent 引擎  │ │ 通道管理    │ │ 插件系统      │
│ (routing/) │ │ (agents/)   │ │ (channels/) │ │ (plugins/)    │
│            │ │ + 上下文引擎│ │ + 20+ 通道  │ │ + 42 扩展     │
└──┬────────┘ └──┬──────────┘ └┬────────────┘ └┬──────────────┘
   │             │              │               │
┌──▼─────────────▼──────────────▼───────────────▼──────────────────┐
│                       基础设施层                                   │
│  Memory (向量搜索 sqlite-vec + FTS)  │  Media (多媒体处理)        │
│  Browser (Playwright 自动化)         │  Cron (定时任务)           │
│  TTS (语音合成)  │  Secrets (凭证管理) │ Device Identity (设备密钥)│
│  mDNS/Tailscale (网络发现)  │  Sandbox (沙箱执行)               │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 核心目录结构

```
openclaw/
├── src/                    # 核心源码 (~884K 行)
│   ├── cli/               # CLI 入口和命令注册
│   ├── commands/           # 180+ CLI 命令实现
│   ├── gateway/            # 网关服务器（核心守护进程）
│   ├── agents/             # Agent 执行引擎
│   ├── channels/           # 通道抽象层
│   ├── routing/            # 消息路由
│   ├── auto-reply/         # 自动回复系统
│   ├── context-engine/     # 上下文引擎
│   ├── memory/             # 记忆系统（向量搜索）
│   ├── media/              # 媒体存储与处理
│   ├── media-understanding/# 多模态理解
│   ├── link-understanding/ # 链接理解
│   ├── browser/            # 浏览器自动化
│   ├── tts/                # 语音合成
│   ├── cron/               # 定时任务
│   ├── plugins/            # 插件加载与管理
│   ├── plugin-sdk/         # 插件 SDK（800+ 导出）
│   ├── hooks/              # 钩子系统
│   ├── config/             # 配置系统
│   ├── infra/              # 基础设施（设备身份、心跳、重启等）
│   ├── daemon/             # 守护进程管理
│   ├── process/            # 进程管理
│   ├── security/           # 安全审计
│   ├── secrets/            # 凭证管理
│   ├── sessions/           # 会话管理
│   ├── acp/                # Agent Client Protocol
│   ├── pairing/            # 设备配对
│   ├── wizard/             # 安装向导
│   ├── tui/                # 终端 UI
│   ├── terminal/           # 终端工具
│   ├── web/                # WhatsApp Web
│   ├── telegram/           # Telegram 实现
│   ├── discord/            # Discord 实现
│   ├── slack/              # Slack 实现
│   ├── signal/             # Signal 实现
│   ├── imessage/           # iMessage 实现
│   ├── line/               # LINE 实现
│   ├── providers/          # LLM 提供商
│   ├── i18n/               # 国际化
│   ├── logging/            # 日志
│   ├── shared/             # 共享工具
│   ├── types/              # 类型定义
│   └── utils/              # 工具函数
├── extensions/             # 42 个插件扩展
├── skills/                 # 54+ 技能模块
├── ui/                     # Web 前端 (Lit)
├── apps/
│   ├── macos/             # macOS 原生应用 (SwiftUI)
│   ├── ios/               # iOS 应用 (Swift)
│   └── android/           # Android 应用 (Kotlin)
├── packages/              # 内部包
│   ├── clawdbot/          # Legacy 兼容
│   └── moltbot/           # Legacy 兼容
├── docs/                  # 文档 (Mintlify)
├── scripts/               # 构建/发布/测试脚本
├── test/                  # 测试夹具和帮助函数
└── vendor/                # 第三方代码
```

---

## 三、Gateway 网关服务

Gateway 是整个 OpenClaw 的心脏，作为常驻守护进程运行。

### 3.1 启动流程

```
entry.ts (Node CLI 入口)
    ↓
cli/run-main.ts (参数解析 → 分发命令)
    ↓
commands/gateway-cli/ → "gateway run"
    ↓
gateway/call.ts → startGatewayServer(options)
    ↓
gateway/server.impl.ts::startGatewayServer()
    ├─ loadConfig()                              // 加载 JSON5 配置
    ├─ resolveGatewayPort()                      // 端口解析（默认 18789）
    ├─ loadOrCreateDeviceIdentity()              // RSA 密钥对
    ├─ loadGatewayTlsRuntime()                   // TLS 证书
    ├─ prepareSecretsRuntimeSnapshot()           // 凭证快照
    ├─ createGatewayRuntimeState()               // 核心运行时状态
    │   ├─ createHttpServer()                    // HTTP/HTTPS 服务器
    │   ├─ WebSocketServer()                     // WebSocket 服务器
    │   ├─ createCanvasHostHandler()             // Canvas A2UI
    │   └─ 客户端追踪 Set + 广播函数
    ├─ listenGatewayHttpServer()                 // 绑定监听
    ├─ startGatewaySidecars()                    // 附属服务
    │   ├─ startBrowserControlServerIfEnabled()  // 浏览器控制
    │   ├─ startGmailWatcherWithLogs()           // Gmail 监听
    │   ├─ startPluginServices()                 // 插件服务
    │   └─ startGatewayMemoryBackend()           // 记忆后端
    ├─ startHeartbeatRunner()                    // 心跳运行器
    ├─ buildGatewayCronService()                 // Cron 服务
    ├─ startGatewayConfigReloader()              // 配置热重载
    ├─ startChannelHealthMonitor()               // 通道健康监控
    ├─ startGatewayDiscovery()                   // mDNS + Tailscale
    ├─ startGatewayMaintenanceTimers()           // 维护定时器
    ├─ getGlobalHookRunner()                     // 全局钩子
    └─ runBootOnce()                             // 执行 BOOT.md
```

### 3.2 运行时状态（server-runtime-state.ts）

```typescript
{
  httpServer: Server;              // HTTP/HTTPS 服务器
  wsServer: WebSocketServer;       // WebSocket 服务器
  clients: Set<WebSocket>;         // 所有连接的客户端
  broadcast(event): void;          // 广播事件
  broadcastToClient(connId, event); // 单播事件
  chatRunState: Map<sessionKey, RunState>; // 进行中的 Agent 运行
  chatAbortControllers: Map<...>;  // 取消控制器
  toolEventRecipients: Map<...>;   // 工具事件接收者
}
```

### 3.3 通信协议（gateway/protocol/）

**帧类型**：
- `RequestFrame` — 客户端 → 服务器 RPC 调用
- `ResponseFrame` — 服务器 → 客户端结果/错误
- `EventFrame` — 服务器 → 客户端广播
- `HelloOk` — 连接握手确认

所有帧通过 AJV JSON Schema 验证。

**连接流程**：
1. 客户端发送 HELLO + 认证信息
2. 服务器验证 token/password/设备签名
3. 授权角色和方法作用域 → 返回 HELLO_OK
4. 客户端发送 REQUEST → 服务器分发到 Handler → 返回 RESPONSE
5. 服务器随时广播 EVENT 到全部/指定客户端
6. 断开时清理（终止聊天、释放锁）

### 3.4 Method Handlers（server-methods/，65+ 模块）

| Handler | 文件 | 职责 |
|---------|------|------|
| `chat.ts` | ~40KB | Agent 对话路由、流式响应、中止 |
| `agent.ts` | - | 单次 Agent 调用 |
| `agents.ts` | - | 多 Agent CRUD |
| `sessions.ts` | - | 会话管理 |
| `config.ts` | - | 配置读/写/补丁/应用 |
| `send.ts` | ~15KB | 出站消息投递 |
| `nodes.ts` | - | 远程节点发现与调用 |
| `cron.ts` | - | Cron 作业调度与执行 |
| `exec-approvals.ts` | - | 命令执行审批 |
| `channels.ts` | - | 通道集成 |
| `secrets.ts` | - | 密钥管理 |
| `health.ts` | - | 服务健康/状态 |
| `skills.ts` | - | 插件技能 |
| `usage.ts` | - | 成本追踪 |

### 3.5 HTTP 路由（server-http.ts）

```
/ → 控制 UI (Web Dashboard)
/api/... → 内部 API
/slack/... → Slack HTTP webhooks
/v1/chat/completions → OpenAI 兼容端点
/openresponses/... → OpenResponses API
/canvas/... → Canvas A2UI WebSocket
/plugins/... → 插件 HTTP 路由（带认证）
/hooks/... → Hook HTTP 端点
```

### 3.6 认证与授权

**认证模式**：
- Token 认证
- Password 认证
- 设备签名（RSA 密钥对）
- TLS 指纹验证
- 本地直连检测（回环地址绕过）

**角色权限** (`role-policy.ts`)：
- `operator` — 完全访问
- `node` — 节点操作权限
- `view-only` — 只读

**速率限制** (`auth-rate-limit.ts`)：
- 固定窗口：20 次失败 / 60 秒
- Hook 认证独立计算

### 3.7 守护进程管理（src/daemon/）

| 平台 | 实现 | 配置位置 |
|------|------|----------|
| **macOS** | LaunchAgent | `~/Library/LaunchAgents/com.openclaw.gateway.plist` |
| **Linux** | systemd user | `~/.config/systemd/user/openclaw-gateway.service` |
| **Windows** | Task Scheduler | `schtasks` 注册 |

统一 `GatewayService` 接口：`install()`, `uninstall()`, `stop()`, `restart()`, `isLoaded()`

---

## 四、消息通道系统

### 4.1 统一 Adapter 接口（channels/plugins/types.adapters.ts）

每个通道必须实现的 Adapter：

| Adapter | 职责 |
|---------|------|
| `ChannelSetupAdapter` | 通道初始化/引导 UI |
| `ChannelConfigAdapter<T>` | 配置解析（allowFrom, defaultTo） |
| `ChannelOutboundAdapter` | 消息发送 |
| `ChannelGatewayAdapter` | Webhook/监听集成 |
| `ChannelStatusAdapter` | 健康/连接状态 |
| `ChannelHeartbeatAdapter` | Keep-alive 信号 |
| `ChannelGroupAdapter` | 群组提及策略、工具策略 |
| `ChannelMentionAdapter` | @提及模式匹配 |
| `ChannelThreadingAdapter` | 线程/话题处理 |
| `ChannelCommandAdapter` | 原生命令支持 |
| `ChannelSecurityAdapter` | DM/安全策略 |
| `ChannelPairingAdapter` | 设备配对逻辑 |

### 4.2 通道 Dock（channels/dock.ts）

轻量级通道元数据注册，提供 capabilities、config resolvers、group policies、mention patterns、threading contexts、text limits — 无需加载重量级实现。

### 4.3 支持的通道

**内置通道**（src/ 直接实现）：
- Telegram (`src/telegram/`) — grammyjs
- Discord (`src/discord/`) — @buape/carbon
- Slack (`src/slack/`) — @slack/bolt
- Signal (`src/signal/`) — signal-cli REST API
- iMessage (`src/imessage/`) — macOS/BlueBubbles
- WhatsApp (`src/web/`) — @whiskeysockets/baileys
- LINE (`src/line/`) — @line/bot-sdk

**扩展通道**（extensions/）：
- MS Teams, Matrix, Mattermost, IRC
- Feishu (飞书), Google Chat
- Nostr, Twitch, Zalo
- Synology Chat, Nextcloud Talk
- BlueBubbles, Tlon
- Voice Call

### 4.4 消息完整流程

```
1. 通道 Webhook/轮询收到消息
    ↓
2. 构建消息上下文 (bot-message-context.ts)
   - 提取 channel, accountId, peer, guild/team, thread
    ↓
3. Gateway RPC: chat.send() (server-methods/chat.ts)
   - 验证 + 清洗消息
    ↓
4. 路由解析 (routing/resolve-route.ts)
   - 按优先级匹配绑定：peer > guild+roles > guild > team > account > channel > default
   - 返回 agentId + sessionKey
    ↓
5. 调度入站 (auto-reply/dispatch.ts)
   - 最终化上下文（信封、时区等）
   - 创建 Reply Dispatcher
    ↓
6. 配置回复 (auto-reply/reply/dispatch-from-config.ts)
   - 加载 session store
   - 去重检查 (dedupe)
   - 防抖检查 (debounce)
   - 触发 hooks (前处理)
   - 命令检测
    ↓
7. 生成回复 (auto-reply/reply/get-reply.ts)
   - 解析指令（reasoning, thinking, verbose, elevated）
   - 模型选择
   - 运行 AI Agent
   - 处理 tool calls
   - 流式输出 blocks
    ↓
8. 投递回复
   - 使用原始 channel/peer
   - 通道特定投递（格式化、线程、反应）
   - 流式或批量发送
    ↓
9. 用户收到消息
```

---

## 五、Agent 引擎与 AI 管线

### 5.1 Agent 执行（src/agents/）

**执行入口**：
- `pi-embedded-runner.ts` → `runEmbeddedPiAgent()` — 内嵌执行（直接调用 Pi 框架）
- `cli-runner.ts` → `runCliAgent()` — CLI 模式
- `acp-spawn.ts` — ACP 子进程 spawn

**Agent 运行上下文**：
```typescript
// 解析过程
resolveAgentRunContext()
    → agent-scope.ts          // Agent 工作区和配置
    → auth-profiles.ts        // 多提供商认证（API key 轮转 + 冷却追踪）
    → skills.ts               // 构建工作区技能快照
    → model-fallback.ts       // 主模型失败时自动回退
```

**可注册工具**（`src/agents/tools/`）：
- `browser-tool.ts` — Playwright 浏览器自动化
- `cron-tool.ts` — 定时任务创建/管理
- `gateway-tool.ts` — Agent 间通信
- `web-search.ts` — 网页搜索
- `web-fetch.ts` — HTTP 获取
- `tts-tool.ts` — 语音合成
- `canvas-tool.ts` — 绘图/图形
- `discord-actions.ts` — Discord 操作
- `agents-list-tool.ts` — Agent 列表查询

### 5.2 上下文引擎（src/context-engine/）

可插拔的上下文管理：

```typescript
interface ContextEngine {
  info: ContextEngineInfo;
  bootstrap?(): Promise<BootstrapResult>;         // 初始化
  ingest(msg, sessionId): Promise<IngestResult>;   // 摄入消息
  ingestBatch?(): Promise<IngestBatchResult>;       // 批量摄入
  afterTurn?(): Promise<void>;                      // 轮次后处理
  assemble(sessionId, messages, tokenBudget): Promise<AssembleResult>; // 组装上下文
  compact(): Promise<CompactResult>;                // 压缩/摘要
  prepareSubagentSpawn?(): Promise<SubagentSpawnPreparation>;
  onSubagentEnded?(): Promise<void>;
  dispose?(): Promise<void>;
}
```

`assemble()` 根据 token 预算组装消息历史 + 系统提示，返回有序消息列表。

### 5.3 记忆系统（src/memory/，100+ 文件）

**混合搜索架构**：
- **BM25 关键词搜索**：SQLite FTS5 全文索引
- **向量搜索**：sqlite-vec 扩展
- **MMR 去重**：Maximum Marginal Relevance，避免重复结果

**嵌入提供商**：
- 云端：OpenAI, Gemini, Voyage AI, Mistral, Cohere
- 本地：Ollama, node-llama-cpp, vLLM
- 批量嵌入：OpenAI/Mistral batch API
- 嵌入缓存：减少 API 成本

**核心文件**：
- `manager.ts` — `MemoryIndexManager` 主管理器
- `embeddings.ts` — 嵌入提供商抽象
- `sqlite.ts`, `sqlite-vec.ts` — 向量 DB
- `search-manager.ts` — 查询搜索接口
- `hybrid.ts` — BM25 + 向量分数融合
- `batch-*.ts` — 批量嵌入作业

### 5.4 多模态理解（src/media-understanding/）

| 模态 | 提供商 | 文件 |
|------|--------|------|
| **图像** | Claude Vision, GPT-4V, Gemini Vision, Mistral | `providers/anthropic/`, `providers/openai/`, `providers/google/` |
| **音频** | Whisper, Deepgram | `transcribe-audio.ts` |
| **视频** | 帧提取 + 时序分析 | `video.ts` |
| **链接** | URL 提取 + CLI 工具摘要 | `src/link-understanding/` |

### 5.5 浏览器自动化（src/browser/，120+ 文件）

基于 Playwright 的完整浏览器控制：

| 能力 | 文件 |
|------|------|
| ARIA 页面快照 | `pw-tools-core.snapshot.ts` |
| 点击/填写/提交 | `pw-tools-core.interactions.ts` |
| 文件上传下载 | `pw-tools-core.downloads.ts` |
| 响应拦截 | `pw-tools-core.responses.ts` |
| Cookie/存储操作 | `pw-tools-core.state.ts` |
| 调试追踪 | `pw-tools-core.trace.ts` |
| Chrome 检测 | `chrome.ts` |
| CDP 集成 | `cdp.ts` |
| WebSocket Bridge | `bridge-server.ts` |
| 浏览器配置文件 | `profiles.ts` |

### 5.6 语音合成（src/tts/）

| 提供商 | 说明 |
|--------|------|
| OpenAI TTS | TTS-1, TTS-1-HD, 6 种声音 |
| ElevenLabs | 多语言 v2 |
| Microsoft Edge TTS | 免费 |

特性：Markdown 剥离、长文本摘要、通道特定格式（Telegram: Opus, 默认: MP3）

### 5.7 定时任务（src/cron/）

- Cron 表达式解析（`croner` 库）
- 隔离 Agent 执行（独立 session）
- 心跳感知调度
- 通道投递 + 执行日志
- 作业持久化

---

## 六、插件/扩展系统

### 6.1 Plugin SDK（src/plugin-sdk/，110+ 文件，800+ 导出）

**主导出**：`src/plugin-sdk/index.ts`
**通道特定导出**：`discord.ts`, `telegram.ts`, `slack.ts`, `imessage.ts`, `signal.ts`, `whatsapp.ts`, `line.ts`, `msteams.ts` 等

**核心工具**：
- `core.ts` — 基础工具
- `compat.ts` — 兼容层
- `runtime.ts` — 运行时环境
- `webhook-*.ts` — Webhook 处理、守卫、限速
- `inbound-*.ts`, `outbound-*.ts` — 消息路由和投递
- `text-chunking.ts` — 长消息分块
- `json-store.ts` — JSON 持久化
- `oauth-utils.ts` — OAuth 助手
- `ssrf-policy.ts` — SSRF 防护
- `persistent-dedupe.ts` — 去重

### 6.2 插件 API（src/plugins/types.ts）

**OpenClawPluginDefinition**：
```typescript
{
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: "memory" | "context-engine";  // 特殊插件类型
  configSchema?: OpenClawPluginConfigSchema;
  register?(api: OpenClawPluginApi): void | Promise<void>;
  activate?(api: OpenClawPluginApi): void | Promise<void>;
}
```

**OpenClawPluginApi** 提供的注册方法：

| 方法 | 用途 |
|------|------|
| `registerTool(factory, opts?)` | 注册 AI 工具 |
| `registerHook(events, handler, opts?)` | 注册生命周期钩子 |
| `registerChannel(plugin)` | 注册消息通道 |
| `registerHttpRoute(params)` | 注册 HTTP 端点 |
| `registerCli(registrar, opts?)` | 注册 CLI 命令 |
| `registerService(service)` | 注册后台服务 |
| `registerProvider(provider)` | 注册认证提供商 |
| `registerCommand(command)` | 注册自定义命令 |
| `registerContextEngine(id, factory)` | 注册上下文引擎 |
| `registerGatewayMethod(method, handler)` | 注册 Gateway RPC |
| `on(hookName, handler, opts?)` | 注册类型安全的钩子 |

**Plugin Runtime**（提供给插件的运行时 API）：
```typescript
{
  version: string;
  config: { loadConfig, writeConfigFile };
  system: { enqueueSystemEvent, requestHeartbeatNow, runCommandWithTimeout };
  media: { loadWebMedia, detectMime, resizeToJpeg };
  tts: { textToSpeechTelephony };
  stt: { transcribeAudioFile };
  tools: { createMemoryGetTool, createMemorySearchTool, registerMemoryCli };
  events: { onAgentEvent, onSessionTranscriptUpdate };
  logging: { shouldLogVerbose, getChildLogger };
  state: { resolveStateDir };
  channel: PluginRuntimeChannel;
  subagent: { run, waitForRun, getSessionMessages, deleteSession };
}
```

### 6.3 插件生命周期

```
1. 发现 → discoverOpenClawPlugins()
   扫描目录：bundled → global → workspace → config

2. Manifest 加载 → loadPluginManifest()
   读取 openclaw.plugin.json 或 package.json

3. 动态模块加载 → jiti
   SDK 别名解析（src/ 或 dist/），缓存

4. 注册 → plugin.register(api)
   注册工具、钩子、通道、服务等

5. 运行时初始化 → createPluginRuntime()
   绑定配置、系统、媒体等 API
```

### 6.4 42 个扩展一览

**通道扩展（18+）**：
telegram, discord, slack, msteams, signal, imessage, whatsapp, googlechat, matrix, mattermost, irc, line, feishu, zalo, zalouser, nextcloud-talk, synology-chat, tlon, bluebubbles, twitch, voice-call, nostr

**功能扩展**：
- `memory-core` — 文件记忆搜索（search_memory, get_memory）
- `llm-task` — LLM 任务执行（classify, summarize）
- `diffs` — Diff 工具
- `copilot-proxy` — Copilot 代理
- `acpx` — ACP 运行时
- `diagnostics-otel` — OpenTelemetry 诊断
- `device-pair` — 设备配对
- `phone-control` — 手机控制
- `thread-ownership` — 线程所有权
- `open-prose` — 文档处理

### 6.5 钩子系统（src/hooks/）

**24 种钩子事件**：

| 事件 | 触发时机 |
|------|----------|
| `before_model_resolve` | LLM 调用前，可覆盖 model/provider |
| `before_prompt_build` | Prompt 组装前 |
| `before_agent_start` | Agent 启动前 |
| `llm_input` | LLM 输入 |
| `llm_output` | LLM 输出 |
| `message_received` | 消息接收 |
| `message_sending` | 消息发送中 |
| `message_sent` | 消息已发送 |
| `before_tool_call` | 工具调用前 |
| `after_tool_call` | 工具调用后 |
| `session_start` | 会话开始 |
| `session_end` | 会话结束 |
| `subagent_*` | 子 Agent 生命周期 |
| `gateway_start` | 网关启动 |
| `gateway_stop` | 网关停止 |

**钩子来源**：
- `openclaw-bundled` — 内置
- `openclaw-managed` — 托管目录
- `openclaw-workspace` — 工作区
- `openclaw-plugin` — 插件注册

### 6.6 Skills 系统（skills/，54+ 模块）

每个 Skill 是一个带 YAML frontmatter 的 SKILL.md，不是代码，而是给 Agent 读的说明书：

```yaml
---
name: github
description: GitHub CLI operations
emoji: 🐙
requirements:
  bins: ["gh"]
---
```

**代表性 Skills**：github, 1password, discord, slack, coding-agent, canvas, spotify-player, weather, obsidian, notion, trello, peekaboo, video-frames, voice-call 等

---

## 七、配置系统（src/config/）

### 7.1 配置格式

JSON5 格式，位于 `~/.openclaw/config.json5`，支持：
- 环境变量替换：`${VAR}`
- 文件包含：`includes: ["other.json5"]`
- 热重载：文件变更自动应用
- 验证：Zod schema + 插件 schema 合并

### 7.2 主要配置节

| 节 | 说明 |
|----|------|
| `gateway` | 端口、绑定地址、TLS、认证 |
| `agents` | Agent 工作区、默认模型、心跳 |
| `channels` | Discord, Telegram, Slack, Signal, iMessage 等 |
| `hooks` | Webhook, Gmail watcher |
| `secrets` | 凭证存储与解析 |
| `skills` | 插件配置 |
| `session` | 会话存储路径、清理策略 |
| `memory` | 嵌入模型、向量搜索 |
| `logging` | 日志级别、文件大小限制 |
| `sandbox` | Docker/Podman 工具执行 |
| `tools` | HTTP 工具、白名单/黑名单 |

### 7.3 会话管理

- 会话元数据存储在磁盘（`~/.openclaw/sessions/`）
- 原子读写 + 文件锁
- 按保留策略清理（年龄、大小、数量）
- 磁盘预算控制

---

## 八、用户界面层

### 8.1 CLI（src/cli/，180+ 命令）

使用 Commander.js，命令延迟加载：

```
openclaw setup          # 安装向导
openclaw config set ... # 配置修改
openclaw agent ...      # Agent 操作
openclaw message send . # 发送消息
openclaw status         # 系统状态
openclaw gateway run    # 启动网关
openclaw daemon start   # 启动守护进程
openclaw channels ...   # 通道管理
openclaw cron ...       # 定时任务
openclaw plugins ...    # 插件管理
openclaw doctor         # 健康检查
openclaw tui            # 终端交互 UI
openclaw security audit # 安全审计
```

### 8.2 TUI（src/tui/）

基于 `@mariozechner/pi-tui` 的终端交互界面：
- 实时聊天
- 流式响应
- 会话管理
- 本地 Shell 执行
- 命令历史
- 主题系统

### 8.3 Web UI（ui/，Lit Web Components）

```
ui/src/ui/
├── app.ts                  # 主 LitElement 组件
├── app-chat.ts             # 聊天功能
├── app-lifecycle.ts        # 生命周期
├── app-gateway.ts          # Gateway 连接
├── app-events.ts           # 事件日志
├── app-render.ts           # DOM 渲染
├── controllers/            # 数据绑定控制器
│   ├── chat.ts
│   ├── agents.ts
│   ├── sessions.ts
│   ├── channels.ts
│   ├── config.ts
│   ├── cron.ts
│   ├── exec-approvals.ts
│   └── ...
├── chat/                   # 消息渲染
│   ├── message-normalizer.ts
│   ├── tool-cards.ts
│   └── copy-as-markdown.ts
└── views/                  # 页面组件
```

Tab 导航：Overview, Chat, Channels, Config, Sessions, Cron, Logs, Debug

### 8.4 原生应用

**macOS App**（apps/macos/，SwiftUI）：
- 菜单栏集成 (`MenuBar.swift`)
- Gateway 进程管理 (`GatewayProcessManager.swift`)
- WebSocket/HTTP 连接 (`GatewayConnection.swift`)
- 语音唤醒 (`VoiceWakeRuntime.swift`)
- 按住说话 (`VoicePushToTalk.swift`)
- Canvas/A2UI 集成
- 屏幕截图、屏幕录制、摄像头捕获
- 日历/提醒/联系人/位置服务

**iOS App**（apps/ios/，Swift）：
- 聊天 UI
- 设备/网关配置
- 媒体/相机
- 引导设置
- Lock Screen Live Activity

**Android App**（apps/android/，Kotlin + Gradle）

### 8.5 ACP — Agent Client Protocol（src/acp/）

标准化的 Agent 通信协议：

**客户端**（`client.ts`）：
- 子进程 spawn + NDJSON 协议
- 权限请求处理：安全工具自动批准，危险工具需确认
- 会话隔离

**服务端**（`server.ts`）：
- stdin/stdout NDJSON 监听
- 翻译 ACP 消息 ↔ Gateway 消息
- 连接/断开管理

---

## 九、安全体系

### 9.1 安全审计框架（src/security/audit.ts）

```typescript
interface SecurityAuditFinding {
  checkId: string;
  severity: "critical" | "warn" | "info";
  title: string;
  detail: string;
  remediation: string;
}
```

**审计检查项**：
- 配置 secrets 扫描
- 文件系统权限分析
- 危险工具目录
- 多用户检测
- 沙箱配置验证
- 插件代码安全
- Skills symlink 逃逸检测
- 模型卫生（小模型警告）
- 节点审批策略
- Hooks 加固
- 不安全标志检测

### 9.2 执行审批（src/infra/exec-approvals.ts）

- 命令模式匹配白名单
- 安全二进制检测（curl, git, npm 等）
- 策略配置（permissive, restricted）
- 命令混淆分析

### 9.3 SSRF 防护

- 主机名白名单
- URL 模式验证
- IP 验证（防内网访问）

---

## 十、基础设施层

### 10.1 设备身份（src/infra/device-identity.ts）

- RSA 密钥对生成/加载
- 存储在 `~/.openclaw/device/key.json`
- 设备签名用于认证
- 公钥导出（Base64URL）

### 10.2 设备配对（src/pairing/）

- 8 字符字母数字配对码（A-Z 去 I/O + 2-9）
- TTL：1 小时
- 每通道最多 3 个待处理请求
- 防路径穿越

### 10.3 网络发现

- **mDNS/Bonjour**：本地网络发现（`src/infra/bonjour-discovery.ts`）
- **Tailscale**：远程网络暴露（`src/infra/tailscale.ts`）

### 10.4 心跳（src/infra/heartbeat-runner.ts）

- 周期性唤醒 Agent
- 配置活跃时段
- 构建心跳 prompt（当前时间、系统事件、队列状态）
- 通过通道投递

---

## 十一、LLM 提供商集成（src/providers/）

支持多种 LLM 提供商：

| 提供商 | 类型 |
|--------|------|
| OpenAI | Chat + Embeddings |
| Anthropic Claude | Chat |
| Google Gemini | Chat + Function Calling |
| Mistral | Chat + Embeddings |
| Cohere | Embeddings |
| Ollama | 本地模型 |
| Voyage AI | Embeddings |
| GitHub Copilot | Token 认证 |
| AWS Bedrock | Chat |
| 自定义 HTTP | 可配置端点 |

**特定提供商文件**：
- `github-copilot-auth.ts` — OAuth + token 刷新
- `github-copilot-models.ts` — 模型枚举
- `google-shared.ts` — Function calling 支持
- `qwen-portal-oauth.ts` — 通义千问 OAuth

---

## 十二、测试体系

### 12.1 测试配置

| 配置 | 用途 |
|------|------|
| `vitest.unit.config.ts` | 单元测试 |
| `vitest.e2e.config.ts` | 端到端测试 |
| `vitest.gateway.config.ts` | 网关测试 |
| `vitest.channels.config.ts` | 通道测试 |
| `vitest.extensions.config.ts` | 扩展测试 |
| `vitest.live.config.ts` | 实机测试（需真实 API key） |

### 12.2 测试命令

```bash
pnpm test                  # 并行执行所有测试
pnpm test:fast             # 快速单元测试
pnpm test:coverage         # 带覆盖率（70% 阈值）
pnpm test:gateway          # 网关测试
pnpm test:channels         # 通道测试
pnpm test:extensions       # 扩展测试
pnpm test:e2e              # 端到端测试
pnpm test:live             # 实机测试
pnpm test:docker:all       # Docker 测试套件
```

---

## 十三、构建与发布

### 13.1 构建流程

```bash
pnpm build
# 等效于：
# 1. canvas:a2ui:bundle      — 打包 Canvas A2UI
# 2. tsdown-build             — TypeScript → JS (tsdown)
# 3. copy-plugin-sdk-root-alias — 插件 SDK 别名
# 4. build:plugin-sdk:dts     — 插件 SDK 类型声明
# 5. write-plugin-sdk-entry-dts
# 6. canvas-a2ui-copy
# 7. copy-hook-metadata
# 8. copy-export-html-templates
# 9. write-build-info
# 10. write-cli-startup-metadata
# 11. write-cli-compat
```

### 13.2 版本管理

版本号格式：`YYYY.M.D`（日历版本）

版本位置：
- `package.json` (CLI)
- `apps/android/app/build.gradle.kts`
- `apps/ios/Sources/Info.plist`
- `apps/macos/Sources/OpenClaw/Resources/Info.plist`
- `docs/install/updating.md`

### 13.3 发布渠道

- **stable**：标记发布 `vYYYY.M.D`，npm dist-tag `latest`
- **beta**：预发布 `vYYYY.M.D-beta.N`，npm dist-tag `beta`
- **dev**：`main` 分支 HEAD

---

## 十四、关键设计模式

| 模式 | 应用 |
|------|------|
| **Handler 模块** | 每个子系统导出 handler 对象，Gateway 聚合 |
| **运行时状态** | 集中式可变状态（clients, chat runs, dedup） |
| **依赖注入** | `CliDeps` 通过调用栈传递，`createDefaultDeps` |
| **广播机制** | Pub/sub 多客户端状态变更 |
| **速率限制** | 认证暴力破解防护 |
| **Secrets 快照** | 每次操作的瞬态内存凭证存储 |
| **Schema 验证** | Zod + AJV 验证所有帧和配置 |
| **延迟加载** | CLI 命令延迟注册，插件动态加载 |
| **Adapter 模式** | 统一通道接口，12+ 种 Adapter |
| **工厂注册** | 通道/插件通过工厂注册 |

---

## 十五、已知问题与设计权衡

来自 `agent-system-design-philosophy.md` 的分析：

### 15.1 Chat-first 的局限

- Agent 被当作聊天机器人，所有能力塞进 system prompt
- 单次调用消耗 16 万+ token 上下文
- 留给实际任务的推理空间被压缩
- 每次操作都经过 LLM 决策，不是真正的自动化

### 15.2 配置复杂度

- 53 个配置文件，字段数量巨大
- Agent 自身无法完全理解合法值，容易产生幻觉
- 配置 schema 虽然有 Zod 验证，但复杂度本身就是问题

### 15.3 代码量

- 884K 行 TypeScript 意味着：
  - 单人难以审计
  - Bug 表面积大
  - 功能与功能之间的交互复杂
  - 新贡献者门槛高

### 15.4 优势

- 通道覆盖最广（20+）
- 插件生态最成熟
- 原生应用支持（macOS/iOS/Android）
- 多提供商 LLM 支持
- 完善的安全模型
- 活跃的开源社区

---

## 十六、重要文件速查表

### 核心入口
| 文件 | 作用 |
|------|------|
| `src/entry.ts` | 进程入口 |
| `src/cli/run-main.ts` | CLI 启动 |
| `src/gateway/server.impl.ts` | Gateway 启动 |
| `src/gateway/server-runtime-state.ts` | 运行时状态 |

### 消息流
| 文件 | 作用 |
|------|------|
| `src/routing/resolve-route.ts` | 路由解析引擎 |
| `src/auto-reply/dispatch.ts` | 入站调度 |
| `src/auto-reply/reply/dispatch-from-config.ts` | 回复协调 |
| `src/auto-reply/reply/get-reply.ts` | 回复生成 |
| `src/gateway/server-methods/chat.ts` | Chat RPC 处理 |
| `src/gateway/server-methods/send.ts` | 出站投递 |

### Agent
| 文件 | 作用 |
|------|------|
| `src/agents/pi-embedded-runner.ts` | 嵌入式 Agent |
| `src/agents/cli-runner.ts` | CLI Agent |
| `src/agents/agent-scope.ts` | Agent 工作区 |
| `src/agents/auth-profiles.ts` | 多提供商认证 |
| `src/agents/skills.ts` | 技能快照 |

### 插件
| 文件 | 作用 |
|------|------|
| `src/plugin-sdk/index.ts` | SDK 主导出 |
| `src/plugins/types.ts` | 插件 API 类型 |
| `src/plugins/loader.ts` | 动态加载 |
| `src/plugins/discovery.ts` | 插件发现 |
| `src/plugins/registry.ts` | 注册表 |

### 配置
| 文件 | 作用 |
|------|------|
| `src/config/io.ts` | 配置读写 |
| `src/config/zod-schema.ts` | Schema 定义 |
| `src/config/validation.ts` | 验证逻辑 |
| `src/config/sessions/store.ts` | 会话存储 |

### 安全
| 文件 | 作用 |
|------|------|
| `src/security/audit.ts` | 安全审计 |
| `src/infra/exec-approvals.ts` | 执行审批 |
| `src/gateway/auth.ts` | 认证 |
| `src/gateway/role-policy.ts` | 角色策略 |
