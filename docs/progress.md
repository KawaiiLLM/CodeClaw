# CodeClaw 实现进度记录

> 最后更新: 2026-03-10
> 最新提交: `b499753` fix: address code review Critical and Important issues (round 2)
> 未提交变更: SDK agent loop 实现、Telegram 多媒体/群聊增强、Dockerfile 非 root 用户

---

## 阶段总览

| Phase | 状态 | 说明 |
|-------|------|------|
| Phase 0: 项目脚手架 | ✅ 完成 | monorepo + 类型 + workspace 模板 |
| Phase 1: 最小内核 | ✅ 完成 | 全部子系统实现 + 两轮 code review |
| Phase 2: Agent 容器运行时 | ✅ 完成 | SDK/chat/stub 三层模式均已实现并验证 |
| Phase 3: Telegram Skill | ✅ 完成 | grammy + 代理 + 图片/贴纸 + 群聊@过滤 |
| Phase 4: 端到端联调 | ✅ 完成 | SDK 模式全链路已验证 (Telegram → Agent SDK → Claude → Telegram) |
| Phase 5: 迭代完善 | 🔲 未开始 | |

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
│   │   ├── messages.ts             # InboundMessage, OutboundMessage, MessageContent
│   │   ├── skill-service.ts        # SkillServiceRegistration (含 channel? 字段)
│   │   └── kernel-api.ts           # KernelAPI, QueueStatus, AgentHealthReport
│   ├── kernel/src/                 # 内核进程 (host 运行)
│   │   ├── index.ts                # 入口，组装各子系统
│   │   ├── http-server.ts          # HTTP API (port 19000), 全部路由
│   │   ├── message-queue.ts        # 优先队列 + Map<key,timestamp> 去重
│   │   ├── io-bridge.ts            # Skill 注册 + channel→skillId 索引 + 出站路由
│   │   ├── container-manager.ts    # dockerode, Colima socket 自动检测
│   │   ├── agent-supervisor.ts     # 健康检查 + 崩溃检测 + 自动重启
│   │   ├── config.ts               # 加载 codeclaw.yaml
│   │   └── logger.ts               # pino
│   └── agent-runtime/              # Agent 容器内运行
│       ├── Dockerfile.dev          # Node 22 + USTC mirror + npmmirror + 非 root 用户
│       ├── package.json            # 依赖: @anthropic-ai/sdk, claude-agent-sdk, undici, pino, zod, MCP SDK
│       └── src/
│           ├── index.ts            # 容器入口, 组装 + 信号处理
│           ├── agent-loop.ts       # ⚡ 核心: SDK/chat/stub 三层模式
│           ├── sdk-mcp-tools.ts    # SDK 原生 MCP server (5 工具 + double-send guard)
│           ├── kernel-client.ts    # HTTP 客户端 (GET/POST kernel API)
│           ├── message-injector.ts # 轮询内核 + drain loop + waitForMessage()
│           ├── mcp-server.ts       # 5 个 MCP 工具 (send_message, queue, skill 管理)
│           ├── mcp-entry.ts        # MCP server 独立入口 (SDK 子进程用)
│           ├── skill-service-manager.ts  # 子进程 Skill 生命周期管理
│           └── logger.ts           # pino
├── skills/
│   └── telegram/
│       ├── service.ts              # grammy bot + 代理 transformer + kernel 注册
│       ├── package.json            # grammy + undici
│       ├── MANUAL.md               # Agent 可读安装指南
│       └── config.schema.json
└── workspace-template/
    ├── CLAUDE.md                   # Agent 自我认知文件
    └── config/
        └── telegram.json.example   # bot_token 模板 (真实 token 在 .gitignore 中)
```

---

## 提交历史

```
b499753 fix: address code review Critical and Important issues (round 2)
ba63647 feat: Telegram end-to-end + Claude API chat mode via proxy
51e41ca feat: Phase 4 integration - Docker dev image and stub mode fixes
8731003 fix: address code review Critical and Important issues
868058f feat: implement CodeClaw MVP (Phase 0-3)
```

---

## Agent Loop 架构 (agent-loop.ts)

### 三层模式 (全部已实现)

1. **SDK 模式** (✅ 已实现, 最高优先级): `@anthropic-ai/claude-agent-sdk` 的 `query()` + Streaming Input
   - 完整 Claude Code 能力: Bash, Read, Write, Edit, Glob, Grep 等内置工具
   - MCP 集成: 通过 `sdk-mcp-tools.ts` 提供 5 个 CodeClaw 工具 (send_message, get_queue_status, skill 管理)
   - Session resume 支持 (`persistSession: true`)
   - CLAUDE.md 加载 (`settingSources: ["project"]`)
   - System prompt 使用 `claude_code` preset + CodeClaw 追加指令
   - Double-send guard: agent 通过 MCP tool 发了消息就不再自动转发 `result.result`
   - MessageStream 桥接: `MessageInjector` → `AsyncIterable<SDKUserMessage>` (null sentinel 关闭)
   - 非 root 运行: Dockerfile 创建 `codeclaw` 用户 (SDK 拒绝 root 下 bypassPermissions)
   - 支持多模态输入: 图片消息以 base64 content block 传入

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
docker run -d --name codeclaw-agent-andy --rm \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID=andy \
  -e ANTHROPIC_API_KEY="sk-proxy-6d6c691839fc123f788e9f43de5a30c2" \
  -e ANTHROPIC_BASE_URL="https://proxy.moedb.moe" \
  -e CLAUDE_MODEL="aws-claude-opus-4-6" \
  -e HTTP_PROXY="http://host.docker.internal:7890" \
  codeclaw/agent-runtime:dev

# 4. 启动 Telegram Skill (host 进程, port 7001)
export https_proxy=http://127.0.0.1:7890
export CONFIG_PATH=/path/to/workspace-template/config/telegram.json
export KERNEL_URL=http://localhost:19000
npx tsx skills/telegram/service.ts &

# 5. 验证
curl http://localhost:19000/api/status  # 查看内核状态
docker logs codeclaw-agent-andy         # 查看 agent 日志
```

---

## 已验证的里程碑

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M1: 内核 HTTP API | ✅ | curl 收发消息, 队列入队/出队 |
| M2: Agent 容器通信 | ✅ | 容器启动, 轮询内核, 收发消息 |
| M3: Agent 回复消息 | ✅ | 收到消息 → 调 Claude API → 回复 |
| M4: Telegram 端到端 | ✅ (聊天级) | TG 消息 → Bot → 内核 → Agent → Claude → 内核 → Bot → TG |
| M5: SDK Agent 模式 | ✅ | Agent SDK query() + MCP tools + session resume 全链路 |
| M6: Telegram 多媒体 | ✅ | 图片 / 贴纸 / 回复引用 → base64 multimodal → Claude Vision |
| M7: 群聊 @提及过滤 | ✅ | 群聊仅在 @bot 或回复 bot 时响应 |

---

## 已知问题 / 技术债

### 已解决

- ~~Agent SDK 模式未接入~~ → ✅ SDK 模式已完整实现 (sdk-mcp-tools.ts + agent-loop.ts runSdkLoop)
- ~~MCP Server 未在 chat 模式中使用~~ → ✅ SDK 模式通过 sdk-mcp-tools.ts 使用 MCP 工具
- ~~Telegram 文件消息~~ → ✅ 图片 (photo) 和贴纸 (sticker) 已支持下载 + base64 转发

### 剩余技术债

1. **内核 ContainerManager 找不到 Colima socket**: `findDockerSocket()` 在 ESM 环境下可能有问题, 需设 `DOCKER_HOST` 环境变量
2. **Telegram Skill 代理**: 使用 Grammy transformer + undici ProxyAgent 绕过 Node.js 内置 fetch 不识别代理的问题; transformer 硬编码 `Content-Type: application/json`, 不支持 multipart/form-data
3. **Chat 模式无工具**: chat 模式仍为纯文字对话, 无 MCP 工具集成 (mcp-server.ts 未在 chat 模式中使用)
4. **Skill 安装体验**: 当前手动配置, 未实现通过自然语言安装
5. **Telegram 音频/文件/视频消息**: 仅支持 photo 和 sticker, 其他媒体类型尚未处理
6. **变更未提交**: 本批 SDK 实现 + Telegram 增强 + Dockerfile 改动尚未 git commit

---

## Kernel HTTP API 参考

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/messages/inbound | Skill → 内核, 入站消息 |
| POST | /api/messages/outbound | Agent → 内核 → Skill, 出站消息 |
| GET | /api/messages/next | Agent 轮询下一条消息 |
| GET | /api/messages/queue | 队列状态 |
| POST | /api/services/register | Skill 注册 |
| POST | /api/services/unregister | Skill 注销 |
| POST | /api/agent/health | Agent 健康上报 |
| GET | /api/status | 内核总状态 |

---

## 两轮 Code Review 修复汇总

### 第一轮 (commit 8731003)
- IOBridge channelIndex 映射修复 (channel→skillId)
- MessageInjector drain loop (单条→全部)
- 去重改用 Map<key, timestamp> 支持过期清理
- HTTP body 1MB 限制
- Telegram replyTo 复合 ID 解析
- 信号处理移入 main() 作用域
- SDK 事件安全访问

### 第二轮 (commit b499753)
- Bot token 从 VCS 移除 (gitignore + .example)
- History trimming 保证首条为 user
- 非空断言改为显式 guard
- Grammy transformer 加 response status check
- 代理环境变量统一 (resolveProxy)
- API 失败后维持 user/assistant 交替
- 心跳从 "busy" 改为 "alive"
- 移除死依赖 claude-agent-sdk (后已重新加回)
