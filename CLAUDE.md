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
- Kernel 是透明代理，不检查/转换消息内容，只负责路由。channel 特定逻辑归 Skill。
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

## 环境约束
- **生产环境**: VPS (104.194.86.117), 2G RAM, Debian, 原生 Docker，无需代理
- **本地开发**: macOS, 中国大陆网络需 HTTP 代理 `127.0.0.1:7890`，Docker via Colima
- **API 代理**: base_url=`https://proxy.moedb.moe`, model=`aws-claude-opus-4-6`
- **镜像源**: Dockerfile 用 USTC debian mirror + npmmirror（不在构建时配代理）

## 部署操作规范
- **部署脚本**: `scripts/deploy.sh [--build] [AGENT_ID]`，自动检测 Colima/原生 Docker
- **Docker volume 是持久数据**：重建容器时必须复用同名 named volume（`codeclaw-{agentId}-home`），绝不能删除或更换 volume name。Volume 中存储 session 文件、配置、聊天记录等不可恢复的数据。
- **端口映射**：anon=7001, sakiko=7002（通过 `DEPLOY_PORT` 指定）
- **API Key**：通过 `~/.claude/config/agent-{agentId}.env` 传入（`--env-file`）
- **禁用实验性 beta**：容器启动必须设 `-e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
- **Linux 必须** `--add-host=host.docker.internal:host-gateway`
- **HTTP_PROXY**: 仅在环境变量存在时传入容器（本地开发需要，服务器不需要）
- **服务器更新流程**: `ssh server → cd ~/codeclaw → git pull → sudo docker build → deploy.sh`
- **VPS 资源紧张 (2G RAM)**：避免在服务器上做重计算，优先利用 Docker 层缓存

## 多 Agent 架构
- 当前 agent: `anon` (port 7001), `sakiko` (port 7002)
- Kernel 通过 `agentId` 路由消息，每个 agent 独立容器 + volume
- 跨 agent 通信: core MCP server 提供 `list_agents` + `send_to_agent` 工具
- Telegram @mention 转发: Skill 注册 `metadata.botUsername`，outbound 消息自动检测 @bot 并广播

## 开发约定
- pnpm workspace monorepo, TypeScript ESM
- 中文交流
- 基于superpowers规范
