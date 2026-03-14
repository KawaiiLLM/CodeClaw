# 个人 AI Agent 系统：设计哲学 V4

> 本文是 CodeClaw 的顶层设计理念文档，描述一个以 Claude Code 为执行引擎的个人 AI Agent 系统应有的样子。
> V1 为原始构想，V2 整合了 OpenClaw / NanoClaw 分析和 Claude Agent SDK 技术验证，V3 进一步整合 TinyClaw 分析、Phase 0-4 实现经验、以及三个参考项目的交叉对比。V4 精简为纯理念文档，模块设计细节移至 design.md。

**一句话定位**：将 Claude Code 的完整编码能力，通过极简微内核架构，连接到日常聊天软件。扩展功能由 Agent 自己安装，不需要人类配置。

---

## 核心哲学：Agent OS，不是 Chatbot Framework

CodeClaw 不是在造聊天机器人框架，而是在造 **AI 的操作系统**。以下三个隐喻是全部设计决策的底层逻辑，后续章节的具体原则皆可归约于此。

### 一切皆文件（Everything is a File）

Unix 用一个统一接口（open/read/write/close）连接了所有异构资源。CodeClaw 把这个原则推到 AI Agent 的语境中：聊天记录是 JSONL 文件，Skill 说明书是 Markdown 文件，配置是 JSON 文件，记忆是 Markdown + SQLite。

**深层含义**：文件系统是 Agent 和框架之间的**唯一契约面**。框架写文件（使信息可达），Agent 读文件（按需获取上下文）。两者通过文件系统解耦，不通过 prompt 注入耦合。传统做法把聊天记录截断注入 prompt、把 Skill 描述塞进 system prompt——本质是框架替 Agent 做了信息筛选的决定。正确的做法是让信息以文件形式存在，Agent 自己判断需要什么。

### 代码即工具（Code is the Tool）

对于拥有 Bash/Write/Edit 能力的 Agent，代码就是最通用的工具接口。不需要插件协议、不需要 UI 配置、不需要 DSL。Agent 的能力上限等于它能写什么代码，而不是框架预置了多少工具。

代码也是压缩上下文的利器。处理多个数据源时，Chat-first 逐个调工具，每个中间结果占上下文；Code-first 写一段脚本一次性处理，只有最终结果进入上下文。实证数据（HuggingFace smolagents）表明，代码模式比工具调用模式减少约 30% 的步骤和 LLM 调用。

**推送 vs 拉取**：MCP 工具普遍采用推送式设计——Playwright 的 `click` 返回完整 accessibility tree + console log + 网络状态，工具作者替 Agent 决定它应该看到什么。Code-first 的替代方案是拉取式设计：`click` 只返回确认，Agent 需要页面结构时自己运行 `snapshot`，需要截图时自己执行 `screenshot`。框架应提供 Unix 式小工具（`read_message` ≈ `cat`），而不是替 Agent 做信息处理的复杂工具。

### Agent 即用户（Agent is a User）

Agent 不是一个"被框架驱动的组件"，而是一个"使用操作系统的程序员用户"。Home 目录 `~` 是 Agent 的全部身份空间，`~/.claude/` 遵循 XDG 式约定（skills, data, cache, config, memory）。安装 Skill ≈ `apt install`，启动服务 ≈ `systemd start`，卸载 ≈ `rm -rf`。

这个隐喻的力量在于：AI 天生理解"程序员使用操作系统"这个概念。不需要教 Agent 学新的框架 API——它已经知道 home 目录是什么、文件系统怎么组织、进程怎么管理。

**关键约束：框架必须简单到 Agent 能理解自身环境。** 当框架复杂度超出 Agent 的推理边界——配置文件过多、抽象层过深、工具定义过于复杂——Agent 被迫在对自身"盲区"的情况下行动。这是幻觉的结构性根源，而非模型能力问题。试金石：让 Agent 回答"你的配置系统怎么工作"，如果它答错了，框架太复杂了。

**框架的角色推论**：框架是进程监督器（Supervisor），不是能力提供者。扫描 manifest 启动进程、分配端口注册路由、传递环境变量恢复 crash 状态。框架不决定 Agent 读什么文件、不解析消息语义、不管理聊天历史截断。框架是内核，不是应用。

**反馈循环**：框架设计不是一次性的。观察 Agent 的实际行为——它反复查询什么信息？什么工具返回值它总是忽略？什么操作它需要多步才能完成？——据此调整工具粒度、返回值、默认行为。Agent 的使用模式是框架迭代的依据。

### 与后续原则的关系

| 后续章节的具体原则 | 归属隐喻 |
|---------|---------|
| 文件系统即上下文、渐进式披露、朴素优先 | 一切皆文件 |
| 代码是一等公民、Skill 是唯一扩展机制、推送 vs 拉取 | 代码即工具 |
| Agent 是用户不是项目、存在感 > 人格、框架可理解性、为 AI 设计、Kernel 只做路由 | Agent 即用户 |

---

## 一、问题：为什么现有方案不够好

### OpenClaw 的问题：Chat-first 的根本局限

OpenClaw 把 agent 当作聊天机器人。所有能力——工具描述、配置 schema、安全规则、skill 说明——都塞进 system prompt，导致单次调用消耗 16 万+ token 的上下文。留给实际任务的推理空间被严重压缩。

更深层的问题是执行模型：agent 每次操作都要经过 LLM 决策。调用三个数据源，中间结果全部回到上下文被"看到"，才能进行下一步。这不是自动化，这是让一个人盯着每一步手动推进。

一个聪明的模型（如 Opus），在 OpenClaw 里表现得"笨"，不是模型变了，而是它的上下文被垃圾占满了。配置文件有 53 个，字段多到 agent 自己都记不住合法值，问它怎么配置，只能产生幻觉。

**实证**：问 OpenClaw 的 agent 怎么配置默认模型，它输出幻觉，实际上根本不是那样配置。同一个 Opus 模型，在 Claude Code 里表现正常，在 OpenClaw 里却"变笨"了——因为信噪比被破坏了。

### NanoClaw 的问题：极简但粗糙

NanoClaw 做对了一件事——以 Claude Agent SDK 为地基，代码量小到可审计。但它的设计选择带来了新问题：

- **无状态容器**：每次消息 spawn 新容器，执行完销毁。Agent 没有"自己的空间"，没有持续存在感。
- **改源码当配置**：没有配置文件，所有定制都通过 Claude Code 修改源代码。这把复杂性从配置转移到了代码变更——同样危险，且不可逆。
- **Per-group 记忆隔离**：每个群组独立记忆。但一个 agent 就是一个人，它应该有统一的记忆，不同群组只是不同的交流场景。
- **轮询架构**：2 秒一次的消息轮询——这是"周末写出来"的工程痕迹，不是深思熟虑的设计。

### TinyClaw 的问题：人格过重，引擎过轻

TinyClaw 是最有"产品感"的参考项目——种子人格引擎、时间衰减记忆、对话式 Skill 安装、内置 Web UI。但它的核心问题在于：

- **自有 Agent Loop**：不使用 Claude Agent SDK，而是自己实现 tool loop + LLM 原生 tool_calls。这意味着放弃了 Claude Code 的核心优势——Bash/Read/Write/Agent 等内置工具、自动上下文压缩、session 持久化。Agent 退化为"会调 API 的聊天机器人"，而不是"会写代码的程序员"。
- **人格做进核心**：Heartware（Soul/Identity 引擎）是框架级组件，每条消息都经过人格渲染管线。框架复杂度上升，但实际能力——解决问题、写代码、管理文件——并未因此增强。人格是"化妆"，存在感才是"骨骼"。
- **无容器隔离**：单进程 Bun 运行时，Shell 命令通过 BunWorker 沙箱执行。一旦 prompt injection 成功，攻击面是整个宿主机。
- **对话式安装仍是人类在装**：Skill 安装通过"配对协议"引导用户填写凭证。比 OpenClaw 的 53 个配置文件友好，但本质上还是人类在做配置，不是 Agent 自己安装。
- **Smart Router 增加复杂度**：按消息复杂度路由到不同模型，但分类器本身就需要 LLM 调用，且误分类会导致用户体验不一致。

### 参考项目总览

| | 代码量 | 架构 | AI 引擎 | 核心优势 | 核心缺陷 |
|---|---|---|---|---|---|
| OpenClaw | ~884K 行 | 网关单体 | Chat API | 全平台通道、完整运维 | Chat-first 上下文爆炸 |
| NanoClaw | ~7K 行 | 微内核 | Claude SDK | 极简、可审计 | 无状态、无 Skill 抽象 |
| TinyClaw | ~28K 行 | 插件单体 | 自有引擎 | 产品感、人格系统 | 无隔离、引擎弱于 SDK |
| **CodeClaw** | 目标 <15K | 微内核 + Skill | Claude SDK | Code-first + 可见思考 | 正在建设中 |

---

## 二、核心理念：Agent 是人，不是工具

### 人格模型 vs. 工具模型

现有系统把 agent 当作工具：输入消息 → 处理 → 输出回复。无状态，无生活，无主动性。

Agent 应该是一个**人格**：

- Agent 有自己的**生活空间**（持久化工作目录），平时在里面干活、整理笔记、积累知识
- Agent 可以到**公共区域**（网络）去浏览、搜索、获取信息
- Agent 通过**各种渠道**（Telegram、Web、API）和人类或其他 AI 交互
- Agent 拥有**统一的记忆**——不会因为换了个聊天窗口就失忆
- Agent 有**自主性**——可以自己安排定时任务、主动汇报、持续学习

这个模型的直接推论：agent 不是"Telegram 里的一个 bot"，也不是"终端里的一个 session"。它是一个独立存在的实体，通道只是它和外界通信的方式。

**存在感 > 人格**：行为连续性（持久工作空间、结构化记忆、跨会话上下文、主动行为）是核心框架级能力。性格参数（Big Five / MBTI 等）是可选的 Skill 级装饰。TinyClaw 把人格做进核心，导致框架复杂度上升但能力并未增强。正确的做法是先建好骨骼（存在感），再按需化妆（人格）。

### 代码是一等公民

Claude Code 之所以强大，是因为它的执行模型不是"一步步调工具"，而是"写代码 → 执行 → 看结果 → 修改 → 再执行"。

代码是压缩上下文的工具。当 agent 需要汇总多个数据源时：
- Chat-first 的做法：逐个调用，每个中间结果占上下文，N 个来源占 N 倍空间
- Code-first 的做法：写一段脚本一次性处理，只有最终结果进入上下文

代码是实现自动化的核心。Agent 也需要代码来实现高效自动化，而不是慢慢地一步步调用工具。这是 Claude Code 范式的真正价值——不是"会写代码的聊天机器人"，而是"用代码思考和行动的 agent"。

### 文件系统即上下文，Agent 自己管理上下文

渐进式披露（Progressive Disclosure）已经成为 AI Agent 的上下文管理范式。但需要更精确地理解它的本质：**渐进式披露不是框架的优化策略，而是 Agent 自主管理上下文的机制。**

SDK 的内置 Skill 系统实现了三层加载：

| 层级 | 内容 | 谁做的 | Token 开销 |
|------|------|--------|-----------|
| Tier 1 | `<available_skills>` XML：name + description + location | SDK 自动注入系统提示 | ~24 tokens/skill |
| Tier 2 | 完整 SKILL.md body | **Agent 自己决定** 用 `read` 加载 | 按需，~500-2000 tokens |
| Tier 3 | `references/` 子目录、data 文件 | **Agent 自己决定** 用 Read/Grep 加载 | 按需 |

**关键洞察：Tier 2 和 Tier 3 的加载决策完全由 Agent 自主完成。** 系统提示只告诉 Agent："scan `<available_skills>` descriptions, if one clearly applies, read its SKILL.md"——然后 Agent 自己判断是否需要、何时需要。这不是框架在"优化"，而是框架把**阅读权交还给了 Agent**。

这正是 Unix 哲学的延伸：进程不需要把整个文件系统装进内存才能工作——它知道文件在哪，需要时去读。Agent 也一样。框架保证信息**可达**（存到文件系统 + 在系统提示中列出位置），Agent 自己决定**读什么**。

CodeClaw 将这个原则从 Skill 推广到**所有信息流**：

| 信息类型 | 存储位置 | 加载方式 |
|---------|---------|---------|
| Skill 知识 | `~/.claude/skills/*/SKILL.md` | SDK 自动列出元数据，Agent 按需 Read 全文 |
| 聊天记录 | `~/.claude/data/<channel>/` | Agent 用 Grep 按需搜索 |
| 聊天中的文件 | 同上（作为聊天记录的一部分） | Agent 决定是否 Read |
| 配置 Schema | `~/.claude/config/` | 修改配置前 Read |
| 结构化记忆 | `~/.claude/memory/` | 需要回忆时查询 |
| 对话历史 | `~/.claude/projects/` | SDK 自动 compact + resume |

**聊天记录即文件**：传统做法是把最近 N 条消息截断后全量注入 LLM——本质是框架替 Agent 决定了它需要看什么。正确的做法是把所有消息持久化到文件系统，Agent 需要上下文时自己 Grep 搜索相关对话。N 条里可能只有几条相关——让 Agent 自己判断。

**设计推论**：
1. **聊天记录持久化为文件，不做内存缓冲** — 每条消息由通道 Skill 进程追加写入 JSONL，Agent 用 Grep 按需查上下文，不再有 history 截断注入。
2. **Skill 知识通过渐进式披露加载** — SKILL.md 的 frontmatter 元数据由 SDK 自动注入系统提示，Agent 按需 `read` 完整内容。不是框架注入，是 Agent 自主阅读。
3. **配置有 schema，Agent 修改前先验证** — schema 是文件，Agent 读了才知道合法值，不靠"记忆"。
4. **阅读的权利属于 Agent** — 框架负责让信息**可达**（文件系统 + 元数据索引），不负责替 Agent 决定**读什么**。

**反模式**：把完整 Skill 内容或聊天历史全量注入系统提示——框架替 Agent 做了信息筛选的决定。正确做法是只提供元数据索引（位置 + 摘要），Agent 自行决定深入阅读哪些。

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
- 不做消息语义理解、Skill 安装逻辑、安全审批、记忆管理

**所有功能，包括通道，都是 Skill。** 安装 Telegram 就是安装一个 I/O 类型的 Skill。内核只需要知道"有消息进来了"和"要把消息发出去"。

---

## 四、Skill 体系：Agent 自己装，不需要人类

### Skill 是唯一的扩展机制

所有功能——通道接入、工具能力、自动化流程——都封装为 Skill。这是 CodeClaw 最锐利的差异化点：**Skill 由 Agent 自己安装，不需要人类配置。**

对于拥有 Claude Code 能力的 Agent，写代码就是最自然的配置方式。不需要设计复杂的"Skill 安装协议"——Agent 本身就是开发者。

### 两类 Skill

**通道 Skill（Channel Skill）**：
- 需要持续运行的独立进程（监听外部平台消息）
- 例：Telegram bot、Discord bot、Web server
- 向 Kernel I/O Bridge 注册，提供 inbound/outbound 消息桥接
- 由 Agent 编写代码 + 启动进程 + 注册

**工具 Skill（Tool Skill）**：
- 不需要独立进程，Agent 自己写脚本/函数直接调用
- 例：天气查询、翻译、计算、文件处理、Git 工作流
- 不需要向 Kernel 注册——Agent 用 Bash/代码直接执行
- 本质上就是 Agent 文件系统里的代码 + 说明书

### "Agent 自己装"的哲学

以 Telegram 通道 Skill 为例，整个安装流程由 Agent 自主完成：Agent 读 SKILL.md 理解这个 Skill，向用户要必要凭证，写入配置文件，安装依赖，启动服务，服务自动向内核 I/O Bridge 注册。

**这就是 Unix 模型**：安装 Skill = `apt install`，启动服务 = `systemctl start`，I/O 注册 = 服务开始监听端口。

### Skill 不修改源码

NanoClaw 的 Skill 是"教 Claude Code 改源代码"。洞察是对的（Agent 用代码配置最自然），但直接改框架源码太危险且不可逆。

Skill 应该是**自包含的**：有自己的目录、自己的说明书、自己的配置 schema。安装 Skill 意味着把它放到 `~/.claude/skills/` 目录，Agent 读它的 SKILL.md 就知道怎么用。卸载就是删除目录。配置修改通过声明式配置文件完成，不通过改代码。

### SKILL.md：Agent 的操作手册，不是人的文档

SKILL.md 遵循 [Agent Skills 开放标准](https://agentskills.io/specification)，由 YAML frontmatter + Markdown body 两部分组成。

**frontmatter 是元数据层（Tier 1）**：SDK 自动扫描所有 SKILL.md 的 frontmatter，将 name + description + 文件路径以紧凑 XML 注入系统提示。这是渐进式披露的入口——Agent 扫描 description 决定是否进一步阅读。

**body 是指令层（Tier 2）**：Agent 决定加载后 `read` 的完整内容。写作要点：
- 面向 Agent 的操作手册，不是面向人的安装文档
- 以动词开头写步骤，不是散文描述
- 聚焦"怎么用"——工具调用方式、数据格式、查询方法
- 500 行以内，超出拆到 `references/` 子目录（Tier 3）

**description 是路由的关键**：写法应该是触发短语，不是营销文案。description 写得差，Agent 要么永远不加载，要么频繁误加载。

Agent 不需要"记住"所有 Skill 的用法——它在系统提示中看到 description 索引，需要时自己 `read` 完整手册。这是 Agent 自主管理上下文的体现：框架只提供元数据索引，阅读决策由 Agent 做出。

---

## 五、Code-first UX：看得见的思考

### 问题

Code-first 意味着 Agent 通过写代码、执行命令来完成任务，而不是把所有能力堆进 system prompt。这比 Chat-first 强大，但也带来延迟问题——Agent 在容器里执行多步操作时，用户在聊天界面看到的是漫长的沉默。

### 解决方案：思考链流式输出

核心机制：Telegram `editMessageText`。Agent 执行复杂任务时，用户看到的是一条不断更新的消息，实时展示工具调用的进度——从"正在读取配置"到"配置修改完成"，过程可见而非黑盒。

在思考链之外，每次 Agent 调用工具时自动发送 Telegram Chat Action，提供即时反馈且零 token 开销：

| 工具类型 | Chat Action | 用户看到的效果 |
|---------|-------------|--------------|
| 文本生成/思考 | `typing` | "正在输入..." |
| 生成/处理图片 | `upload_photo` | "正在发送照片..." |
| 上传文件 | `upload_document` | "正在发送文件..." |

### 为什么这比 Chat-first 好

- **Chat-first（OpenClaw）**：把所有工具描述塞进 system prompt -> 16 万 token 上下文 -> 推理空间被压缩 -> 能力反而弱
- **Code-first（CodeClaw）**：Agent 拥有真实的文件系统和 CLI -> 工具能力无上限 -> 流式展示过程 -> 用户不觉得慢

---

## 六、安全模型：三层防御

Docker 隔离是地基，但不够。需要在隔离之上增加**约束层**和**审批层**。

```
Layer 1: Docker 隔离 (进程/文件系统/网络边界)
    |
Layer 2: 约束白名单 (Agent 能做什么)
    |
Layer 3: 交互式审批 (危险操作需人类确认)
```

**Layer 1 — Docker 隔离**：每个 Agent 的工作环境是一个 Docker 容器，以非 root 用户运行。容器是 agent 的"公寓"——停机关灯锁门东西都在，重启开门一切照旧，迁移打包卷搬到新服务器。Bash 工具不需要白名单——容器本身就是沙箱。prompt injection 最多破坏容器内环境，无法影响宿主机。

**Layer 2 — 约束白名单**：存储在容器外（Kernel 级配置），Agent 无法修改自己的约束。包含出站白名单、挂载白名单、网络白名单。

**Layer 3 — Emoji 审批**：Agent 遇到超出约束的操作时，发 Telegram 消息请求审批。Approver 白名单中的用户 react 👍 批准，👎 拒绝；超时自动拒绝。实现为 Skill 而非内核功能。

**为什么用 Emoji 而不是文字**：零打字成本，一个点击；不污染聊天历史（reaction 不是独立消息）；群聊中不打断其他对话。

---

## 七、记忆与上下文：分层存储 + 朴素智能

### 各司其职的存储策略

| 数据类型 | 存储方式 | 原因 |
|----------|----------|------|
| **对话历史** | JSONL（SDK 原生） | SDK 自动管理，resume/compact 基于此格式，不对抗框架 |
| **结构化记忆** | SQLite FTS5 | agent 主动整理的知识、联系人、偏好。BM25 全文检索足够轻量 |
| **长期笔记** | Markdown 文件 | agent 写的总结、项目笔记，人也能读 |
| **配置** | JSON/YAML | Skill 配置、通道凭证等 |

Claude Code 不用数据库——因为它的场景是单次编程任务，session 结束就完了。但长期存在的 agent 需要跨 session 的结构化记忆。

**关键原则**：内核提供环境（SQLite 可用、文件系统可用），agent 根据 SKILL.md 的指引知道该把什么存在哪。就像一个程序员知道什么该写文件、什么该存数据库。

### 目录结构：Agent 是 Unix 用户，不是项目

Agent 的"家"不是一个项目目录，而是一个 Unix 用户主目录。需要做编程任务时自己创建项目目录，就像真正的开发者。

SDK 的 `cwd` 设为 home 目录，于是 `~/CLAUDE.md` 和 `~/.claude/` 自然合一——对 SDK 来说，这个"项目"就是 Agent 本身。不需要区分"全局 vs 项目级"。

```
/home/codeclaw/                      # ~ = Agent 的家
├── CLAUDE.md                        # Agent 身份（SDK 从 cwd 加载）
│
├── .claude/                         # 框架规范目录 ──────────────────
│   ├── skills/                      #   Skill 代码 + SKILL.md
│   │   ├── telegram/                #     通道 Skill
│   │   └── weather/                 #     工具 Skill
│   ├── data/                        #   Skill 持久化数据（按 skill-id 隔离）
│   │   ├── telegram/                #     内部结构由 Skill 自行约定
│   │   └── weather/
│   ├── cache/                       #   临时文件（可安全清理，不丢关键数据）
│   │   └── <skill-id>/
│   ├── memory/                      #   Agent 级记忆（知识库、日记）
│   ├── config/                      #   Agent 级声明式配置
│   ├── settings.json                #   SDK 项目设置
│   └── projects/                    #   SDK 会话存储（自动管理）
│
└── （Agent 自由空间）                # ──────────────────────────────
    └── Projects/xxx/                #   按需创建的编程项目
```

**框架只规范三个数据目录**：

| 目录 | 类比 | 语义 | 生命周期 |
|------|------|------|---------|
| `~/.claude/skills/<id>/` | 程序安装目录 | Skill 代码 + SKILL.md | 卸载时删除 |
| `~/.claude/data/<id>/` | `~/.local/share/` | Skill 持久化数据 | Skill 自行管理 |
| `~/.claude/cache/<id>/` | `~/.cache/` | 临时文件 | 框架可定期清理 |

Skill 在 `data/<id>/` 内部的目录结构由 Skill 自行约定（写在 SKILL.md 里），框架不干涉。`~/` 下的其他空间完全留给 Agent 自组织。

### 朴素优先，按需升级

默认方案是朴素的：文件系统 + grep + SQLite FTS5。模型自己理解自己的数据在哪，需要什么就去找。

当朴素方法不够时，可以安装"高级检索 Skill"。但这是可选的扩展，不是内核功能。

---

## 八、并发模型：单一人格 + 消息队列 + 自主调度

### 问题

多通道意味着多个人可能同时给 agent 发消息。并行运行多个 agent 进程会导致工作空间写冲突。

### 方案：单一 Agent 进程 + 插入式消息

Agent 是一个"人"——一个人不会分裂成两个自己同时工作。Agent 使用 SDK 的 Streaming Input Mode 作为长驻进程，通过 AsyncGenerator 持续接收消息。

**同一会话/群聊**：新消息直接插入 Streaming Input。这是同一个对话场景的自然延续。

**不同会话/不同用户**：内核在 Agent 的工具调用间隙注入系统通知，告知有新消息在等待，以及当前任务状态。Agent 自主判断优先级：简单查询可以插队处理，关键步骤则稍后处理（甚至主动告知发件人"我正在忙，稍后回复"）。

**这符合"Agent 是人"的哲学**——一个人同时收到多条消息，自己判断先回哪个。不需要并行进程，不需要锁，不会有写冲突。Agent 可以选择 spawn 子 agent 并行处理独立子任务来加速。

---

## 九、成本优化：分层模型选择

### 不是所有消息都需要 Opus

内核做轻量分类（正则/规则，零 LLM 成本）：
- 触发词命令（"/status", "/help"）→ 内核直接处理，不调 LLM
- 简单对话（短消息，无复杂意图）→ Haiku（快，便宜）
- 复杂任务（代码、分析、多步骤）→ 用户选择的主模型（Opus/Sonnet）

更进一步：主 agent 用 Opus 思考策略，spawn 的子 agent 用 Sonnet 做具体执行——SDK 原生支持 per-subagent 的 `model` 参数。

### 空闲成本为零

Session 文件在磁盘上，不消耗 API 费用。只有实际对话时按 token 计费。通过控制 system prompt 大小（CLAUDE.md + 按需加载 Skill 说明书，而非全量注入），每次交互相比 OpenClaw 可节省 90%+ 的 token。

---

## 十、多 Agent：不是独立 feature，而是 agent 的自然能力

主 agent 自己理解何时需要、如何管理子 agent。这通过说明书中的指令实现，不需要单独的"多 agent 框架"。

当任务足够复杂时，主 agent 可以 spawn subagent 并行处理，每个 subagent 完成后汇报结果，主 agent 负责整合。这是 Claude Agent SDK 原生支持的能力，不需要额外抽象。子 Agent 嵌套深度限制为一层，并行子 Agent 完全支持。

不同的 agent 实例之间才需要记忆隔离。同一个 agent 的不同 session、不同通道之间，共享统一记忆。

---

## 十一、LLM 提供商：API 中转层解耦

通过已有的多提供商 API 中转层解决供应商锁定问题。Agent SDK 调用中转 API，中转 API 路由到实际的 LLM 提供商（Anthropic、OpenAI、Gemini、本地模型等）。Agent 完全不感知具体用的是哪家。

---

## 十二、用户体验：零操作原则

### 用户永远不需要编辑文件

无论是安装、配置修改、还是 Skill 管理，用户都通过自然语言与 agent 交互。Agent 负责执行一切。用户提供 API Key 和必要凭证，其他所有事情（依赖安装、目录初始化、配置生成、服务注册）由 agent 完成。

### Agent 自己理解自己的框架

这是最关键的一点。OpenClaw 的 agent 不理解自己的配置规则，所以产生幻觉。

在这个系统里，agent 的框架知识不来自塞进 prompt 的 16 万 token，而来自它**随时可以去读的文件**：工作目录的结构是确定的（agent 知道什么在哪），每个 Skill 有说明书（agent 按需加载），配置文件有 schema（agent 修改前先验证）。

模型不需要"记住"框架的所有细节——它只需要知道去哪找。这才是真正消除幻觉的方式。

---

## 十三、架构全景

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
│  │         Docker Container (卷挂载 /home/codeclaw)    │  │
│  │                                                     │  │
│  │  ┌─────────────────────────────────────┐            │  │
│  │  │  Agent 进程 (Claude Agent SDK)      │            │  │
│  │  │  - cwd = ~ (home = "项目")          │            │  │
│  │  │  - Streaming Input (长驻)           │            │  │
│  │  │  - 自动上下文压缩 + session resume  │            │  │
│  │  │  - 子 Agent 并行                    │            │  │
│  │  └─────────────────────────────────────┘            │  │
│  │                                                     │  │
│  │  /home/codeclaw/ (持久化卷)                         │  │
│  │  ├── CLAUDE.md              # Agent 身份            │  │
│  │  └── .claude/               # 框架规范目录          │  │
│  │      ├── skills/            #   Skill 代码+SKILL.md │  │
│  │      ├── data/<skill-id>/   #   Skill 持久化数据    │  │
│  │      ├── cache/<skill-id>/  #   临时文件（可清理）   │  │
│  │      ├── memory/            #   Agent 记忆          │  │
│  │      ├── config/            #   Agent 配置          │  │
│  │      └── projects/          #   SDK 会话（自动）     │  │
│  │                                                     │  │
│  │  Skill 服务进程 (容器内运行, 内核监督)               │  │
│  │  ├── telegram-service -> I/O Bridge 注册            │  │
│  │  ├── web-ui-service -> I/O Bridge 注册              │  │
│  │  └── ...                                           │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────┐                                        │
│  │ API 中转层    │  <- 多提供商路由 (已有)                 │
│  └──────────────┘                                        │
│                                                          │
│  ┌──────────────────────────────────────┐                │
│  │ 安全约束 (Kernel 级, Agent 不可修改)  │                │
│  │  - 出站白名单 / 挂载白名单 / 网络白名单│                │
│  │  - Emoji 审批网关 (Skill)            │                │
│  └──────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────┘
```

---

## 十四、与参考项目的对比

### 多维对比

| 维度 | NanoClaw (~7K 行) | TinyClaw (~28K 行) | OpenClaw (~884K 行) | **CodeClaw (<15K 行)** |
|------|-------------------|-------------------|--------------------|-----------------------|
| 架构 | 微内核 | 插件单体 | 网关单体 | 微内核 + Skill |
| AI 引擎 | Claude SDK | 自有 tool loop | Chat API | Claude SDK |
| 进程隔离 | Docker | 无 | 无 | Docker |
| 扩展方式 | 改源码 | 对话式配对 | 53+ 配置文件 | Agent 写代码 + 启动 |
| 执行模式 | Code-first | Chat-first | Chat-first | Code-first + 流式展示 |
| 安全 | Docker + 白名单 | Shield + 文字审批 | RBAC + 执行审批 | Docker + 白名单 + Emoji 审批 |
| 记忆 | CLAUDE.md 文件 | 3 层自适应 (Episodic+FTS5+Decay) | 有但无自主性 | SQLite FTS5 + Markdown |
| 过程可见性 | 无 | 简单状态 | 无 | 实时思考链 + Chat Action |

### 借鉴与取舍

| 来源 | 借鉴 | 丢弃 |
|------|------|------|
| NanoClaw | "写代码就是配置"、白名单安全、可审计代码量 | 无 Skill 抽象、轮询架构 |
| TinyClaw | 对话式审批交互 → Emoji 审批、时间衰减记忆评分 | 自有 Agent Loop、无容器隔离、人格做进核心 |
| OpenClaw | Adapter 模式通道抽象、Hook 扩展点 | Chat-first、配置爆炸、代码膨胀 |

---

## 十五、设计原则清单

**一切皆文件：**
1. **文件系统即上下文** — 信息存在文件系统，Agent 按需 Read/Grep。框架保证可达，不替 Agent 决定读什么。
2. **朴素优先** — 文件系统 + grep + SQLite。够用就不加复杂度。
3. **存在感 > 人格** — 记忆、主动行为、工作连续性是核心；性格参数是装饰。

**代码即工具：**
4. **代码是一等公民** — Agent 用代码思考和行动，不是一步步调工具。
5. **拉取优于推送** — 工具返回最小确认，Agent 按需获取更多信息。不替 Agent 做信息筛选。
6. **两种 Skill** — 通道 Skill 是独立进程（持续监听），工具 Skill 是 Agent 写的代码（按需调用）。
7. **看得见的思考** — 流式展示工具调用链 + Chat Action 即时反馈，不做黑盒。

**Agent 即用户：**
8. **Agent 是用户，不是项目** — home 目录是 Agent 的家，编程任务按需创建项目目录。
9. **框架可理解性** — 框架必须简单到 Agent 能理解自身环境。Agent 幻觉是框架复杂度问题，不是模型问题。
10. **Kernel 只做路由** — 消息进来，消息出去，容器活着。框架是监督器，不是应用。
11. **三层安全** — 隔离是地基，约束是围墙，审批是门禁。
12. **代码量即技术债** — 目标 <15K 行核心代码。如果一个功能让代码量翻倍，它不应该在核心里。

**可量化约束：**
- MCP 工具 ≤ 10 个（超过后 Agent 工具选择准确率急剧下降）
- 框架核心代码 <15K 行（可在一个下午审阅——对人和 Agent 都是）
- 每个 Skill 元数据 ≤ 50 tokens（系统提示中的固定开销）

---

## 十六、一句话总结

> **一个以 Claude Agent SDK 为执行引擎、以 Unix 微内核为架构原则、以人格模型为设计灵魂的个人 AI Agent 系统。**
>
> 代码是一等公民，文件系统是上下文，Skill 是唯一的扩展机制，home 目录是 agent 的家，容器是安全边界，模型的推理能力替代复杂中间件。框架为 AI 而设计，让 AI 能发挥"程序员用户"的全部能力，从而为真实用户赋能。
