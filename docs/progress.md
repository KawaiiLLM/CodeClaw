# CodeClaw 实现进度记录

> 最后更新: 2026-03-13
> 最新提交: `b6785b3` fix: stop typing on send_message + safeSlice for surrogate safety

---

## 阶段总览

| Phase | 状态 | 说明 |
|-------|------|------|
| Phase 0: 项目脚手架 | ✅ 完成 | monorepo + 类型 + workspace 模板 |
| Phase 1: 最小内核 | ✅ 完成 | 全部子系统实现 + 两轮 code review |
| Phase 2: Agent 容器运行时 | ✅ 完成 | SDK/chat/stub 三层模式均已实现并验证 |
| Phase 3: Telegram Skill | ✅ 完成 | grammy + 代理 + 图片/贴纸 + 群聊@过滤 |
| Phase 4: 端到端联调 | ✅ 完成 | SDK 模式全链路已验证 (Telegram → Agent SDK → Claude → Telegram) |
| Phase 5a: Home 目录迁移 | ✅ 完成 | /workspace → /home/codeclaw, JSONL 聊天持久化, 通知风格消息 |
| Phase 5: 活跃状态 + 进度消息 | ✅ 完成 | 两层信号架构: Chat Action (自动 typing) + Progress Messages (Agent 主动) |
| Phase 6: 安全约束与审批 | 📋 待实现 | 白名单 + Emoji 审批 |

---

## 仓库结构

```
codeclaw/
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml             # packages/* + skills/*
├── tsconfig.json                   # 共享 TS 配置
├── codeclaw.yaml                   # 内核配置 (port: 19000, image: dev)
├── .dockerignore
├── docs/
│   ├── implementation-plan.md      # 原始实施计划
│   ├── agent-system-design-philosophy.md  # V2 设计哲学
│   └── progress.md                 # ← 本文件
├── packages/
│   ├── types/src/                  # 共享类型
│   │   ├── messages.ts             # InboundMessage, OutboundMessage (含 editMessageId, progress)
│   │   ├── skill-service.ts        # SkillServiceRegistration (含 channel? 字段)
│   │   └── kernel-api.ts           # KernelAPI, QueueStatus, AgentHealthReport
│   ├── kernel/src/                 # 内核进程 (host 运行)
│   │   ├── index.ts                # 入口，组装各子系统
│   │   ├── http-server.ts          # HTTP API (port 19000), 全部路由, 出站透传 Skill 响应
│   │   ├── message-queue.ts        # 优先队列 + Map<key,timestamp> 去重
│   │   ├── io-bridge.ts            # Skill 注册 + channel→skillId 索引 + 出站路由 (/send 或 /edit)
│   │   ├── container-manager.ts    # dockerode, Colima socket 自动检测
│   │   ├── agent-supervisor.ts     # 健康检查 + 崩溃检测 + 自动重启
│   │   ├── config.ts               # 加载 codeclaw.yaml
│   │   └── logger.ts               # pino
│   └── agent-runtime/              # Agent 容器内运行
│       ├── Dockerfile.dev          # Node 22 + USTC mirror + npmmirror + 非 root 用户
│       ├── package.json            # 依赖: @anthropic-ai/sdk, claude-agent-sdk, undici, pino, zod, MCP SDK
│       └── src/
│           ├── index.ts            # 容器入口, 组装 + 信号处理
│           ├── agent-loop.ts       # ⚡ 核心: SDK/chat/stub 三层模式 + typing indicator
│           ├── sdk-mcp-tools.ts    # SDK 原生 MCP server (7 工具 + double-send guard)
│           ├── kernel-client.ts    # HTTP 客户端 (GET/POST kernel API, 返回 messageId)
│           ├── message-injector.ts # 轮询内核 + drain loop + waitForMessage()
│           ├── mcp-server.ts       # MCP 工具 (send_message, queue, skill 管理)
│           ├── mcp-entry.ts        # MCP server 独立入口 (SDK 子进程用)
│           ├── skill-service-manager.ts  # 子进程 Skill 生命周期管理 + getEndpoint()
│           └── logger.ts           # pino
├── skills/
│   └── telegram/
│       ├── service.ts              # grammy bot + /send /edit /action 端点 + JSONL
│       ├── package.json            # grammy + undici
│       ├── SKILL.md                # Agent 可读安装指南
│       └── config.schema.json
└── workspace-template/
    ├── CLAUDE.md                   # Agent 自我认知文件 (含进度反馈指引)
    └── config/
        └── telegram.json.example   # bot_token 模板 (真实 token 在 .gitignore 中)
```

---

## 提交历史

```
b6785b3 fix: stop typing on send_message + safeSlice for surrogate safety
514bdb3 feat: Phase 5 — typing indicators + progress messages (two-layer signals)
d0b20fe docs: address Phase 5 plan review — 3 fixes
3877daf docs: rewrite Phase 5 plan — two-layer signal architecture
6575886 docs: distill core philosophy — Agent OS, not Chatbot Framework
ea7c52b fix: address code review Critical and Important issues
ea1c0d8 feat: manifest-based skill lifecycle with dynamic port allocation
031db3c feat: run Telegram Skill inside container as child process
6d26bf7 fix: address code review Critical and Important issues
227c239 refactor: migrate from /workspace to /home/codeclaw + JSONL chat persistence
868058f feat: implement CodeClaw MVP (Phase 0-3)
```

---

## Agent Loop 架构 (agent-loop.ts)

### 三层模式 (全部已实现)

1. **SDK 模式** (✅ 已实现, 最高优先级): `@anthropic-ai/claude-agent-sdk` 的 `query()` + Streaming Input
   - 完整 Claude Code 能力: Bash, Read, Write, Edit, Glob, Grep 等内置工具
   - MCP 集成: 通过 `sdk-mcp-tools.ts` 提供 7 个 CodeClaw 工具 (send_message, skip_reply, update_progress, get_queue_status, skill 管理 ×3)
   - Session resume 支持 (`persistSession: true`)
   - CLAUDE.md 加载 (`settingSources: ["project"]`)
   - System prompt 使用 `claude_code` preset + CodeClaw 追加指令
   - Double-send guard: agent 通过 MCP tool 发了消息就不再自动转发 `result.result`
   - MessageStream 桥接: `MessageInjector` → `AsyncIterable<SDKUserMessage>` (null sentinel 关闭)
   - 非 root 运行: Dockerfile 创建 `codeclaw` 用户 (SDK 拒绝 root 下 bypassPermissions)
   - 支持多模态输入: 图片消息以 base64 content block 传入
   - **Typing indicator**: `setInterval` 每 4s 发 typing 到 Skill `/action`, send_message 后立即停止
   - **Progress messages**: `update_progress` MCP 工具, 首次发送新消息, 后续编辑已有消息

2. **Chat 模式** (✅ 降级方案): `@anthropic-ai/sdk` 的 `Messages.create()`
   - 纯文字对话, 无工具调用
   - 支持对话历史 (MAX_HISTORY=50)
   - 支持自定义 base_url, model, HTTP proxy
   - 有重试逻辑 (3 次, 指数退避)

3. **Stub 模式**: 无 API key 时的回显模式

### 模式选择逻辑
```
SDK 可用 + API key → SDK 模式 (完整 Agent, 含工具调用)
SDK 不可用 + API key → chat 模式 (纯聊天)
无 API key → stub 模式 (回显)
```

### 两层信号架构 (Phase 5)
```
Layer 1 — Chat Action（自动，零 token，不经 Kernel）
  agent-loop.ts setInterval 每 4s
    → 直接调 Skill /action (localhost:port)
      → Telegram sendChatAction("typing")
  send_message 调用后立即 stopTyping()

Layer 2 — 进度消息（Agent 主动，有 token，经 Kernel）
  Agent 调用 update_progress MCP 工具
    → Kernel POST /api/messages/outbound
      → Skill /edit (editMessageText) 或 /send (新建消息)
  出站链路返回 messageId (4 层透传)
```

---

## 运行环境

### 用户网络环境
- 在中国大陆, 需要 HTTP 代理访问外网
- 代理地址: `127.0.0.1:7890` (host), Docker 容器内用 `host.docker.internal:7890`
- Docker 镜像内使用 USTC Debian mirror + npmmirror

### Docker
- 使用 Colima 提供 Docker daemon (macOS)
- Docker socket: `~/.colima/default/docker.sock`
- 环境变量: `DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock`
- 镜像: `codeclaw/agent-runtime:dev`

### API 代理
- API Key: `sk-proxy-6d6c691839fc123f788e9f43de5a30c2`
- Base URL: `https://proxy.moedb.moe`
- Model: `aws-claude-opus-4-6`
- 注意: Docker 容器内的 SDK/API 调用需要通过 HTTP_PROXY 访问
- **必须设置** `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (Bedrock 代理不支持 `context_management` 等实验性参数)

---

## 端到端启动流程

```bash
# 0. 环境准备
export DOCKER_HOST=unix:///Users/zhaoqixuan/.colima/default/docker.sock
colima start  # 如果未启动

# 1. 安装依赖
pnpm install

# 2. 启动内核 (host 进程, port 19000)
npx tsx packages/kernel/src/index.ts &

# 3. 启动 Agent 容器 (Docker)
docker run -d --name codeclaw-agent-andy \
  -v /path/to/.agent-home:/home/codeclaw \
  -p 7001-7099:7001-7099 \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID=andy \
  -e ANTHROPIC_API_KEY="sk-proxy-6d6c691839fc123f788e9f43de5a30c2" \
  -e ANTHROPIC_BASE_URL="https://proxy.moedb.moe" \
  -e CLAUDE_MODEL="aws-claude-opus-4-6" \
  -e HTTP_PROXY="http://host.docker.internal:7890" \
  -e HTTPS_PROXY="http://host.docker.internal:7890" \
  -e https_proxy="http://host.docker.internal:7890" \
  -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  codeclaw/agent-runtime:dev

# 4. 验证
curl http://localhost:19000/api/status  # 查看内核状态
docker logs codeclaw-agent-andy         # 查看 agent 日志
```

> 注: Telegram Skill 现在由容器内 Agent 自动启动 (manifest-based), 无需手动启动。端口 7001-7099 需映射到 host 以便 Kernel 回调。

---

## 已验证的里程碑

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M1: 内核 HTTP API | ✅ | curl 收发消息, 队列入队/出队 |
| M2: Agent 容器通信 | ✅ | 容器启动, 轮询内核, 收发消息 |
| M3: Agent 回复消息 | ✅ | 收到消息 → 调 Claude API → 回复 |
| M4: Telegram 端到端 | ✅ | TG 消息 → Bot → 内核 → Agent → Claude → 内核 → Bot → TG |
| M5: SDK Agent 模式 | ✅ | Agent SDK query() + MCP tools + session resume 全链路 |
| M6: Telegram 多媒体 | ✅ | 图片 / 贴纸 / 回复引用 → base64 multimodal → Claude Vision |
| M7: 群聊 @提及过滤 | ✅ | 群聊仅在 @bot 或回复 bot 时响应 |
| M8: Home 目录迁移 | ✅ | /workspace → /home/codeclaw, JSONL 聊天持久化, 通知风格消息 |
| M9: Typing 指示器 | ✅ | 处理消息时 Telegram 显示"正在输入...", 回复后立即停止 |
| M10: 进度消息 | ✅ | update_progress MCP 工具, 出站链路返回 messageId, /edit 端点 |

---

## 已知问题 / 技术债

### 已解决

- ~~Agent SDK 模式未接入~~ → ✅ SDK 模式已完整实现 (sdk-mcp-tools.ts + agent-loop.ts runSdkLoop)
- ~~MCP Server 未在 chat 模式中使用~~ → ✅ SDK 模式通过 sdk-mcp-tools.ts 使用 MCP 工具
- ~~Telegram 文件消息~~ → ✅ 图片 (photo) 和贴纸 (sticker) 已支持下载 + base64 转发
- ~~Telegram 回复引用截断 emoji 导致 API 500~~ → ✅ `safeSlice()` 按 code point 截断, 不切割代理对
- ~~回复后仍显示 typing~~ → ✅ `onMessageSent` 回调在 `send_message` 后立即停止 typing

### 剩余技术债

1. **内核 ContainerManager 找不到 Colima socket**: `findDockerSocket()` 在 ESM 环境下可能有问题, 需设 `DOCKER_HOST` 环境变量
2. **Telegram Skill 代理**: 使用 Grammy transformer + undici ProxyAgent 绕过 Node.js 内置 fetch 不识别代理的问题; transformer 硬编码 `Content-Type: application/json`, 不支持 multipart/form-data
3. **Chat 模式无工具**: chat 模式仍为纯文字对话, 无 MCP 工具集成 (mcp-server.ts 未在 chat 模式中使用)
4. **Skill 安装体验**: 当前手动配置, 未实现通过自然语言安装
5. **Telegram 音频/贴纸/视频消息**: DM 中 sticker/audio/voice/video 被静默丢弃, 仅群聊 buffer
6. **JSONL 同步写入**: `appendFileSync` 在高消息量下可能阻塞 event loop, 考虑异步写入

---

## Kernel HTTP API 参考

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/messages/inbound | Skill → 内核, 入站消息 |
| POST | /api/messages/outbound | Agent → 内核 → Skill, 出站消息 (返回 Skill 响应含 messageId) |
| GET | /api/messages/next | Agent 轮询下一条消息 |
| GET | /api/messages/queue | 队列状态 |
| POST | /api/services/register | Skill 注册 |
| POST | /api/services/unregister | Skill 注销 |
| POST | /api/agent/health | Agent 健康上报 |
| GET | /api/status | 内核总状态 |

## Telegram Skill HTTP API 参考

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /send | 发送消息 (支持 `progress` 标记跳过 JSONL, 返回 `messageId`) |
| POST | /edit | 编辑已发送的消息 (不写 JSONL) |
| POST | /action | 发送 chat action (如 typing, 失败静默) |
