# 个人 AI Agent 系统：设计哲学 V2

> 本文是一份顶层设计理念文档，描述一个以 Claude Code 为执行引擎的个人 AI Agent 系统应有的样子。
> V1 版为原始构想，V2 版整合了对 OpenClaw / NanoClaw 的深度分析、Claude Agent SDK 技术验证、以及多轮设计讨论的结论。

---

## 一、问题：为什么现有方案不够好

### OpenClaw 的问题：Chat-first 的根本局限

OpenClaw（约 884K 行 TypeScript，4,679 个源文件）把 agent 当作聊天机器人。所有能力——工具描述、配置 schema、安全规则、skill 说明——都塞进 system prompt，导致单次调用消耗 16 万+ token 的上下文。留给实际任务的推理空间被严重压缩。

更深层的问题是执行模型：agent 每次操作都要经过 LLM 决策。调用三个数据源，中间结果全部回到上下文被"看到"，才能进行下一步。这不是自动化，这是让一个人盯着每一步手动推进。

一个聪明的模型（如 Opus），在 OpenClaw 里表现得"笨"，不是模型变了，而是它的上下文被垃圾占满了。配置文件有 53 个，字段多到 agent 自己都记不住合法值，问它怎么配置，只能产生幻觉。

**实证**：问 OpenClaw 的 agent 怎么配置默认模型，它输出幻觉，实际上根本不是那样配置。问它今天星期几，它连时区都没考虑。同一个 Opus 模型，在 Claude Code 里表现正常，在 OpenClaw 里却"变笨"了——因为信噪比被破坏了。

### NanoClaw 的问题：极简但粗糙

NanoClaw（约 6,915 行 TypeScript）做对了一件事——以 Claude Agent SDK 为地基，代码量小到可审计。但它的设计选择带来了新问题：

- **无状态容器**：每次消息 spawn 新容器，执行完销毁。Agent 没有"自己的空间"，没有持续存在感。
- **改源码当配置**：没有配置文件，所有定制都通过 Claude Code 修改源代码。这把复杂性从配置转移到了代码变更——同样危险，且不可逆。
- **Per-group 记忆隔离**：每个群组独立记忆。但一个 agent 就是一个人，它应该有统一的记忆，不同群组只是不同的交流场景。
- **轮询架构**：2 秒一次的消息轮询、文件系统 IPC——这些是"周末写出来"的工程痕迹，不是深思熟虑的设计。

---

## 二、核心理念：Agent 是人，不是工具

### 人格模型 vs. 工具模型

现有系统把 agent 当作工具：输入消息 → 处理 → 输出回复。无状态，无生活，无主动性。

我认为 agent 应该是一个**人格**：

- Agent 有自己的**生活空间**（持久化工作目录），平时在里面干活、整理笔记、积累知识
- Agent 可以到**公共区域**（网络）去浏览、搜索、获取信息
- Agent 通过**各种渠道**（Telegram、Web、API）和人类或其他 AI 交互
- Agent 拥有**统一的记忆**——不会因为换了个聊天窗口就失忆
- Agent 有**自主性**——可以自己安排定时任务、主动汇报、持续学习

这个模型的直接推论：agent 不是"Telegram 里的一个 bot"，也不是"终端里的一个 session"。它是一个独立存在的实体，通道只是它和外界通信的方式。

### 代码是一等公民

Claude Code 之所以强大，是因为它的执行模型不是"一步步调工具"，而是"写代码 → 执行 → 看结果 → 修改 → 再执行"。

代码是压缩上下文的工具。当 agent 需要汇总多个数据源时：
- Chat-first 的做法：逐个调用，每个中间结果占上下文，N 个来源占 N 倍空间
- Code-first 的做法：写一段脚本一次性处理，只有最终结果进入上下文

代码是实现自动化的核心。Agent 也需要代码来实现高效自动化，而不是慢慢地一步步调用工具。这是 Claude Code 范式的真正价值——不是"会写代码的聊天机器人"，而是"用代码思考和行动的 agent"。

### 为 AI 设计框架，而非为人类设计后让 AI 适应

这是最根本的设计哲学。Claude Code 之所以"有灵性"，是因为它的框架——目录结构、session 命名、CLAUDE.md 机制——从第一天就是为 AI 设计的。AI 能理解自己的工作框架，所以：

- subagent 没有创建预期的文件 → 它知道去读 subagent 的思考过程排查原因
- 上下文丢失 → 它知道 session 文件在哪，可以恢复
- 不确定某个能力 → 它知道自己的能力边界，不会输出幻觉

OpenClaw 不是为 AI 设计的——它是为人类用户设计的 CLI 工具，然后试图让 AI 在里面工作。所以 AI 不理解自己的配置系统，产生幻觉。

**我们的目标是把这种"灵性"从 CLI 延伸到聊天软件、网页、任何通道。** 一旦 AI 能在框架中发挥出自己作为"程序员用户"的全部能力，它就可以作为一个可靠的伙伴，为真实用户赋能。

---

## 三、架构哲学：Unix 式微内核

### 类比

| Unix | Agent 系统 |
|------|-----------|
| 内核 | Agent 核心（进程/session 管理 + I/O 抽象 + 消息调度 + 进程监督） |
| 文件系统 | 工作空间（持久化存储） |
| 设备驱动 | 通道适配器（Telegram/Web/API，以 Skill 服务形式运行） |
| 系统调用 | 基础原语（读写文件、执行代码、网络请求） |
| 用户态程序 | Skill |
| Shell | 自然语言接口 |

### 内核做五件事

1. **Agent/Session 生命周期管理**：创建、销毁、恢复 session，管理 agent 状态
2. **I/O Bridge**：提供统一的消息收发接口，供 Skill 服务注册和路由消息
3. **工作空间管理**：提供 agent 可访问的持久化文件系统
4. **消息队列与路由**：多通道消息排队、优先级、去重、来源标记
5. **进程/容器监督**：Agent 进程崩溃检测、重启、session resume；Skill 服务进程监督

> 补充说明：进程监督和消息队列不能作为 Skill 存在——因为 Skill 运行在 Agent 进程内，Agent 死了 Skill 也死了。这两项是内核的固有职责。

### 内核不做的事

- 不知道怎么发 Telegram 消息（那是通道 Skill 的事）
- 不知道怎么爬网页（那是爬虫 Skill 的事）
- 不知道怎么做检索（那是检索 Skill 的事）
- 不知道怎么管理日程（那是日程 Skill 的事）

**所有功能，包括通道，都是 Skill。** 安装 Telegram 就是安装一个 I/O 类型的 Skill。内核只需要知道"有消息进来了"和"要把消息发出去"。

---

## 四、Skill 体系：用户态程序的包管理

### Skill 是唯一的扩展机制

所有功能——通道接入、工具能力、自动化流程——都封装为 Skill。Skill 之间有依赖关系，像 pip/npm 那样管理。

### Skill 不修改源码

NanoClaw 的 Skill 是"教 Claude Code 改源代码"。这太危险。

Skill 应该是**自包含的**：有自己的目录、自己的说明书（给 agent 读的 MANUAL.md）、自己的配置 schema。安装 Skill 意味着把它放到 skills/ 目录，agent 读它的说明书就知道怎么用。卸载就是删除目录。

**配置修改通过声明式配置文件完成，不通过改代码。** Agent 读 Skill 的说明书，知道哪些配置字段合法、值域是什么，验证后再写入配置文件。

### 两类 Skill

经过技术验证，Skill 需要分为两类：

**知识型 Skill**（纯说明书，agent 按说明操作）：
```
skills/git-workflow/
├── MANUAL.md          # 告诉 agent 怎么用 Git
└── config.schema.json # 如有配置需求
```
Agent 读说明书后，用已有的 Bash/Read/Write 工具执行。无额外代码。

**运行时 Skill**（自包含的可执行服务模块）：
```
skills/telegram/
├── MANUAL.md          # 告诉 agent 这个 skill 做什么、怎么配置
├── service.ts         # 可执行的通道服务代码
├── config.schema.json # 配置 schema（Bot Token 等）
└── package.json       # 依赖声明
```
Agent 读说明书后，按步骤安装依赖、写配置、启动服务。服务自动向内核的 I/O Bridge 注册。

**安装流程（以 Telegram 为例）**：
1. Agent 读 `MANUAL.md`，理解这个 Skill
2. Agent 读 `config.schema.json`，向用户要必要凭证（Bot Token）
3. Agent 写入 `config/telegram.json`
4. Agent 执行: `npm install --prefix skills/telegram/`
5. Agent 启动服务: `node skills/telegram/service.ts`
6. 服务自动向内核 I/O Bridge 注册："我是 telegram 通道，我在 localhost:7001 监听"
7. 内核开始把 telegram 消息路由到 agent

**这就是 Unix 模型**：安装 Skill ≈ `apt install`，启动服务 ≈ `systemctl start`，I/O 注册 ≈ 服务开始监听端口。

### 层次化说明书

每个 Skill 包含给 agent 读的说明书，不是给人读的文档。说明书告诉 agent：
- 这个 Skill 做什么
- 怎么安装它的依赖
- 配置文件有哪些字段，合法值是什么
- 怎么验证安装是否成功
- 怎么使用它

Agent 不需要"记住"所有 Skill 的用法——它知道说明书在哪，需要时去读。这就避免了 OpenClaw 的核心问题：把所有知识塞进 prompt 导致上下文爆炸。

---

## 五、记忆与上下文：分层存储 + 朴素智能

### 各司其职的存储策略

| 数据类型 | 存储方式 | 原因 |
|----------|----------|------|
| **对话历史** | JSONL（SDK 原生） | SDK 自动管理，resume/compact 基于此格式，不对抗框架 |
| **结构化记忆** | SQLite FTS5 | agent 主动整理的知识、联系人、偏好。BM25 全文检索足够轻量 |
| **长期笔记** | Markdown 文件 | agent 写的总结、项目笔记，人也能读 |
| **配置** | JSON/YAML | Skill 配置、通道凭证等 |

Claude Code 不用数据库——因为它的场景是单次编程任务，session 结束就完了。但长期存在的 agent 需要跨 session 的结构化记忆。

**关键原则**：内核提供环境（SQLite 可用、文件系统可用），agent 根据 MANUAL.md 的指引知道该把什么存在哪。就像一个程序员知道什么该写文件、什么该存数据库。

### 工作空间结构

```
workspace/
├── .claude/              # SDK session 数据（自动管理，不手动碰）
├── memory/
│   ├── knowledge.db      # SQLite FTS5（结构化记忆）
│   ├── people.md         # 人物关系笔记
│   └── journal/          # 日记/反思
├── skills/               # 已安装的 Skills
│   ├── telegram/         # 运行时 Skill
│   ├── web-search/       # 知识型 Skill
│   └── ...
├── config/               # 声明式配置文件
├── scratch/              # 临时工作区
└── CLAUDE.md             # Agent 的"自我认知"文件
```

### 朴素优先，按需升级

默认方案是朴素的：文件系统 + grep + SQLite FTS5。模型自己理解自己的数据在哪，需要什么就去找。

**瓶颈估算**：

| 使用规模 | 数据量 | 朴素方案 |
|----------|--------|----------|
| 1 个月，1 个通道 | <5MB | 完全可行 |
| 6 个月，3 个通道 | 50-100MB | FTS5 覆盖 |
| 1 年+，5+ 通道 | 200MB-1GB | 可能需要向量检索 Skill |

当朴素方法不够时，可以安装"高级检索 Skill"。但这是可选的扩展，不是内核功能。

---

## 六、并发模型：单一人格 + 消息队列 + 自主调度

### 问题

多通道意味着多个人可能同时给 agent 发消息。并行运行多个 agent 进程会导致工作空间写冲突。

### 方案：单一 Agent 进程 + 插入式消息

Agent 是一个"人"——一个人不会分裂成两个自己同时工作。Agent 使用 SDK 的 Streaming Input Mode 作为长驻进程，通过 AsyncGenerator 持续接收消息。

**同一会话/群聊**：新消息直接插入 Streaming Input。这是同一个对话场景的自然延续。

**不同会话/不同用户**：内核在 Agent 的工具调用间隙注入系统通知：

```
[系统] 你有 1 条新消息来自 telegram/alice:「今天天气怎么样」
当前任务: 正在帮 web/bob review 代码
你可以选择：立即回复 / 等当前任务完成后处理
```

Agent 自主判断优先级：
- 天气查询很快 → 先回复 alice → 继续 review
- 正在关键步骤 → 决定稍后处理（甚至可以主动告知 alice："我正在忙，稍后回复你"）

**这符合"Agent 是人"的哲学**——一个人同时收到多条消息，自己判断先回哪个。不需要并行进程，不需要锁，不会有写冲突。

**代价**：如果 agent 正在做 5 分钟的长任务，其他消息需要等。但这也是真实人类的行为。Agent 可以选择 spawn 子 agent 并行处理独立子任务来加速。

---

## 七、成本优化：分层模型选择

### 不是所有消息都需要 Opus

```
消息到达 → 内核做轻量分类（正则/规则，零 LLM 成本）
  │
  ├─ 触发词命令 ("/status", "/help") → 内核直接处理，不调 LLM
  │
  ├─ 简单对话 (短消息, 无复杂意图) → Haiku (快, 便宜)
  │
  └─ 复杂任务 (代码, 分析, 多步骤) → 用户选择的主模型 (Opus/Sonnet)
```

Claude Code 的 `/fast` 模式就是这个思路。用户可以随时在快/深之间切换，或者让 agent 自己判断。

更进一步：主 agent 用 Opus 思考策略，spawn 的子 agent 用 Sonnet 做具体执行——SDK 原生支持 per-subagent 的 `model` 参数。

### 空闲成本为零

Session 文件在磁盘上，不消耗 API 费用。只有实际对话时按 token 计费。通过控制 system prompt 大小（CLAUDE.md + 按需加载 Skill 说明书，而非全量注入），每次交互相比 OpenClaw 可节省 90%+ 的 token。

---

## 八、安全模型：容器隔离

### 每个 Agent 的工作环境是一个 Docker 容器

```
docker run -d \
  --name agent-andy \
  -v agent-andy-workspace:/workspace \   # 持久化卷
  --network agent-network \              # 隔离网络
  agent-runtime:latest
```

**容器是 agent 的"公寓"**：
- 停机 → 公寓关灯锁门，东西都在
- 重启 → 开门进去，一切照旧
- 迁移 → 打包卷，搬到新服务器

**安全边界**：
- Agent 在容器内有充分权限（方便安装依赖、管理服务）
- 但无法逃逸到宿主机
- 网络通过内核的 I/O Bridge 代理
- Bash 工具不需要白名单——容器本身就是沙箱
- prompt injection 最多破坏容器内环境，无法影响宿主机

**Skill 服务运行在 Agent 容器内**，由内核的进程监督负责——容器重启后自动重启 Skill 服务。保持简单。

**持久化保证**：容器可以停止、重启、甚至迁移，但 workspace 卷中的所有数据（session、memory、skills、config）完整保留。Agent 恢复后 resume session 即可继续工作。

---

## 九、多 Agent：不是独立 feature，而是 agent 的自然能力

主 agent 自己理解何时需要、如何管理子 agent。这通过说明书中的指令实现，不需要单独的"多 agent 框架"。

当任务足够复杂时，主 agent 可以 spawn subagent 并行处理，每个 subagent 完成后汇报结果，主 agent 负责整合。这是 Claude Agent SDK 原生支持的能力，不需要额外抽象。

**SDK 约束**：子 Agent 嵌套深度限制为一层（子 Agent 不能再 spawn 子 Agent）。并行子 Agent 完全支持。

不同的 agent 实例之间才需要记忆隔离。同一个 agent 的不同 session、不同通道之间，共享统一记忆。

---

## 十、LLM 提供商：API 中转层解耦

通过已有的多提供商 API 中转层解决供应商锁定问题。Agent SDK 调用中转 API，中转 API 路由到实际的 LLM 提供商（Anthropic、OpenAI、Gemini、本地模型等）。Agent 完全不感知具体用的是哪家。

---

## 十一、用户体验：零操作原则

### 用户永远不需要编辑文件

无论是安装、配置修改、还是 Skill 管理，用户都通过自然语言与 agent 交互。Agent 负责执行一切。

理想的首次安装：
- 用户提供 API Key
- 用户选择通道（如 Telegram）并提供必要凭证
- 其他所有事情（依赖安装、目录初始化、配置生成、服务注册）由 agent 完成

### Agent 自己理解自己的框架

这是最关键的一点。OpenClaw 的 agent 不理解自己的配置规则，所以产生幻觉。

在这个系统里，agent 的框架知识不来自塞进 prompt 的 16 万 token，而来自它**随时可以去读的文件**：
- 工作目录的结构是确定的，agent 知道什么在哪
- 每个 Skill 有说明书，agent 按需加载
- 配置文件有 schema，agent 修改前先验证

模型不需要"记住"框架的所有细节——它只需要知道去哪找。这才是真正消除幻觉的方式。

---

## 十二、架构全景

```
┌──────────────────────────────────────────────────────────┐
│                     内核 (宿主机进程)                      │
│                                                          │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ 消息队列   │  │ I/O Bridge   │  │ 进程/容器监督    │  │
│  │ (优先级+   │  │ (Skill 服务  │  │ (崩溃重启 +     │  │
│  │  去重+标记)│  │  注册+路由)  │  │  session resume) │  │
│  └─────┬─────┘  └──────┬───────┘  └────────┬─────────┘  │
│        │               │                    │            │
│  ┌─────▼───────────────▼────────────────────▼─────────┐  │
│  │              Docker Container (持久化卷)             │  │
│  │                                                     │  │
│  │  ┌─────────────────────────────────────┐            │  │
│  │  │  Agent 进程 (Claude Agent SDK)      │            │  │
│  │  │  - Streaming Input (长驻)           │            │  │
│  │  │  - 自动上下文压缩                    │            │  │
│  │  │  - 子 Agent 并行                    │            │  │
│  │  │  - 主模型: 用户选择                  │            │  │
│  │  │  - 简单消息: Haiku                  │            │  │
│  │  └─────────────────────────────────────┘            │  │
│  │                                                     │  │
│  │  workspace/ (持久化)                                │  │
│  │  ├── .claude/              # SDK session (JSONL)   │  │
│  │  ├── memory/               # 结构化记忆 + 笔记     │  │
│  │  │   ├── knowledge.db      # SQLite FTS5           │  │
│  │  │   └── journal/          # Markdown 笔记         │  │
│  │  ├── skills/               # 已安装 Skills          │  │
│  │  │   ├── telegram/         # 运行时 Skill          │  │
│  │  │   └── git-workflow/     # 知识型 Skill          │  │
│  │  ├── config/               # 声明式配置            │  │
│  │  ├── scratch/              # 临时工作区             │  │
│  │  └── CLAUDE.md             # Agent 自我认知        │  │
│  │                                                     │  │
│  │  Skill 服务进程 (容器内运行, 内核监督)               │  │
│  │  ├── telegram-service → I/O Bridge 注册            │  │
│  │  ├── web-ui-service → I/O Bridge 注册              │  │
│  │  └── ...                                           │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────┐                                        │
│  │ API 中转层    │  ← 多提供商路由 (已有)                 │
│  └──────────────┘                                        │
└──────────────────────────────────────────────────────────┘
```

---

## 十三、一句话总结

> **一个以 Claude Agent SDK 为执行引擎、以 Unix 微内核为架构原则、以人格模型为设计灵魂的个人 AI Agent 系统。**
>
> 代码是一等公民，Skill 是唯一的扩展机制，工作空间是 agent 的持久化"公寓"，容器是安全边界，模型的推理能力替代复杂中间件。框架为 AI 而设计，让 AI 能发挥"程序员用户"的全部能力，从而为真实用户赋能。

---

## 附录 A：Claude Agent SDK 技术验证摘要

以下是经过技术调研确认的 SDK 能力和约束（截至 2026 年 3 月）：

### 已确认可行

| 能力 | 说明 |
|------|------|
| **Streaming Input Mode** | AsyncGenerator 作为 prompt，agent 进程长驻，消息可持续注入 |
| **Session 持久化** | 自动写入 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` |
| **Session Resume** | 通过 `resume: sessionId` 跨进程/跨重启恢复会话 |
| **MCP 自定义工具** | stdio/http/sse 三种传输，通过 `mcpServers` 注册 |
| **Tool Search** | 工具超过上下文 10% 时自动按需加载（减少 85% 上下文消耗） |
| **自动上下文压缩** | 接近 200K 限制时自动摘要旧历史，CLAUDE.md 不受压缩影响 |
| **子 Agent** | 通过 `Agent` 工具 spawn，独立上下文，支持并行 |
| **Hooks** | `PreCompact`（压缩前存档）、`PreToolUse`（工具调用前拦截） |
| **精细工具控制** | `Bash(npm:*)` 这样的命令级权限限制 |
| **Per-subagent 模型** | 子 Agent 可用不同模型（Opus 主 Agent + Sonnet 子 Agent） |
| **空闲零成本** | Session 文件在磁盘，不消耗 API 费用 |
| **成本追踪** | `ResultMessage.total_cost_usd` + per-model 拆分 |

### 已确认的约束

| 约束 | 影响 | 应对 |
|------|------|------|
| **每次 `query()` ~12s 启动开销** | 不适合频繁重启 | 使用 Streaming Input 保持长驻 |
| **子 Agent 嵌套限制：仅一层** | 不能递归 spawn | 并行子 Agent 替代 |
| **MCP 工具上下文成本** | 58 个工具 ≈ 55K tokens | Tool Search 自动优化 |
| **上下文窗口 200K** | 超长对话需压缩 | SDK 自动 compact，关键规则写 CLAUDE.md |

### SDK 版本

- TypeScript: `@anthropic-ai/claude-agent-sdk` v0.2.71
- 底层 CLI: `@anthropic-ai/claude-code` v2.1.71

---

## 附录 B：需要进一步解决的问题

1. **Skill 服务的 IPC 协议设计**：Skill 服务如何向内核 I/O Bridge 注册？HTTP? Unix Socket? 需要定义具体协议。
2. **消息格式标准化**：跨通道的统一消息格式（文本、图片、音频、文件附件）。
3. **Skill 包格式规范**：MANUAL.md 的结构化格式、config.schema.json 的标准、依赖声明规范。
4. **内核的最小实现**：具体的模块划分、接口定义、技术选型。
5. **多 Agent 实例**：如果用户想要多个独立 agent（如工作助手 + 生活助手），如何管理多个容器。
6. **容器镜像设计**：基础镜像包含什么（Node.js + SDK + 常用工具），Skill 的依赖如何动态安装。
7. **升级策略**：内核升级时如何保证 workspace 兼容性、Skill 版本管理。
