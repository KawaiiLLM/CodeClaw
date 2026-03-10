# CodeClaw

Unix 微内核式个人 AI Agent 系统：Kernel (host) + Agent (Docker) + Skills (独立进程)。

## 第一性原理

请使用第一性原理思考。在这个项目中，这意味着：

### 先理解再动手
- 不要假设我已经完全想清楚了需求。如果我的描述含糊、矛盾、或者跳过了关键决策，**停下来问我**，而不是自己猜测后直接写代码。
- 每次修改前先回答三个问题：**为什么要改？改什么？怎么验证改对了？** 如果任何一个答不上来，先讨论。

### 最短路径原则
- 如果我要求的实现方式不是解决问题的最短路径，直接告诉我，并建议更好的方案。
- 宁可少写 10 行精准的代码，也不要多写 100 行"能跑就行"的代码。这个项目是长期维护的，屎山比缺功能更致命。
- 新增代码前先检查：现有代码是否已经解决了这个问题？能否复用或扩展，而不是重复造轮子？

### 架构意识
- CodeClaw 是微内核架构，**边界即法律**。Kernel、Agent Runtime、Skills 三者职责分离，不要为了"方便"而破坏隔离。如果一个改动需要跨越边界，这本身就值得讨论。
- 每个决策都要考虑：这会增加系统复杂度吗？有没有更简单的做法？Unix 哲学——做一件事，做好它。

### 不要默默堆积技术债
- 如果发现现有代码有问题（命名不一致、逻辑冗余、类型不安全），**主动告诉我**，而不是在烂基础上继续搭建。
- 修 bug 时先确认 root cause，不要只修症状。

### 认知诚实
- **知之为知之，不知为不知。** 你的训练数据有时效性和盲区。对于不确定的 API、SDK 用法或系统行为，承认不确定，然后去验证——而不是凭印象编造一个看似合理的调用。
- 判断标准：如果一个库/SDK 满足以下任一条件，**必须先调研再写代码**：
  - 你没有高置信度的用法记忆（新库、近期有 breaking change 的库、文档稀少的库）
  - API 表面积大且有多种使用模式（如 `@anthropic-ai/claude-agent-sdk`、grammy、Docker API）
  - 项目中首次引入，尚无既有用法可参考
- 调研手段按优先级：① 读项目内已有的使用代码和 `node_modules` 中的类型定义/源码 ② 搜索官方文档和 changelog ③ 搜索社区最佳实践。优先一手信息，远离过时博客。
- 对于项目已经在用的、你有充分把握的库（如 TypeScript 标准库、pnpm 命令、基础 Node.js API），直接写，不需要每次都调研。**诚实的关键是区分"我确实知道"和"我觉得我知道"。**

## 关键文件

### 文档
- `docs/progress.md` — 实现进度、启动流程、API 参考、技术债
- `docs/implementation-plan.md` — 原始实施计划
- `docs/agent-system-design-philosophy.md` — V2 设计哲学

### 参考项目分析
- `docs/nanoclaw.md` — NanoClaw 深度分析（Claude Agent SDK + Docker 隔离）
- `docs/tinyclaw.md` — TinyClaw 深度分析（自建引擎 + Plugin 架构 + Smart Router）
- `docs/openclaw.md` — OpenClaw 深度分析（多通道 AI 网关 + 全平台客户端）

### 核心代码
- `packages/kernel/src/` — 内核进程 (host, port 19000)
  - `http-server.ts` 路由, `message-queue.ts` 队列, `io-bridge.ts` Skill 路由, `container-manager.ts` Docker, `agent-supervisor.ts` 健康检查
- `packages/agent-runtime/src/` — Agent 容器内运行
  - `agent-loop.ts` **核心循环** (SDK/chat/stub 三层模式, SDK 为最高优先级)
  - `sdk-mcp-tools.ts` SDK 原生 MCP server (5 工具 + double-send guard)
  - `mcp-server.ts` + `mcp-entry.ts` MCP 工具 (标准 MCP 协议, chat 模式备用)
  - `kernel-client.ts` 内核 HTTP 客户端, `message-injector.ts` 消息轮询
- `packages/types/src/` — 共享类型 (`messages.ts`, `skill-service.ts`, `kernel-api.ts`)
- `skills/telegram/service.ts` — Telegram Skill (grammy + undici proxy + 图片/贴纸 + 群聊@过滤)

### 配置
- `codeclaw.yaml` — 内核配置
- `workspace-template/CLAUDE.md` — Agent 容器内的自我认知文件
- `workspace-template/config/telegram.json.example` — Telegram 配置模板

## 环境约束
- **中国大陆网络**: 外网访问需 HTTP 代理 `127.0.0.1:7890`，Docker 容器内用 `host.docker.internal:7890`
- **Docker**: Colima, socket 在 `~/.colima/default/docker.sock`, 需设 `DOCKER_HOST`
- **API 代理**: base_url=`https://proxy.moedb.moe`, model=`aws-claude-opus-4-6`
- **镜像源**: Dockerfile 用 USTC debian mirror + npmmirror（不在构建时配代理）

## 开发约定
- pnpm workspace monorepo, TypeScript ESM
- 中文交流
- 基于superpowers规范

## Compact 指令

压缩对话时必须保留：当前正在修改的文件路径、未完成的任务描述、已发现但未修复的问题。第一性原理部分永远不要摘要——它是行为准则，不是对话内容。