# CodeClaw 设计哲学 V3

> 基于三个参考项目（NanoClaw、TinyClaw、OpenClaw）的交叉对比，结合 CodeClaw Phase 0-4 实现经验，重新校准的顶层设计哲学。

---

## 一句话定位

**将 Claude Code 的完整编码能力，通过极简微内核架构，连接到日常聊天软件。扩展功能由 Agent 自己安装，不需要人类配置。**

---

## 五个设计方向

### 1. Agent 本质：Person, not Tool

Agent 不是无状态的聊天机器人，而是一个有持续存在感的"人"。

**核心（框架级）**：
- **行为连续性**：持久工作空间（Docker volume）、结构化记忆（SQLite FTS5 + markdown notes）、跨会话上下文
- **主动行为**：定时任务、后台整理、主动通知——即使用户不发消息，Agent 也在工作
- **自我认知**：Agent 通过 CLAUDE.md 理解自己的架构和能力，不会对自身框架产生幻觉

**可选（Skill 级）**：
- **人格**：基于种子生成的性格参数（Big Five / MBTI 等），作为 Skill 而非核心框架
- 理由：人格是"化妆"，存在感是"骨骼"。TinyClaw 把人格做进核心，导致框架复杂度上升但能力并未增强

**参考项目对比**：
| | 存在感 | 人格 | 判断 |
|---|---|---|---|
| NanoClaw | ❌ 无状态容器 | ❌ 无 | 太薄 |
| TinyClaw | ✅ 记忆+遗忘曲线 | ✅ 种子人格引擎 | 人格过重 |
| OpenClaw | ⚠️ 有记忆但无自主性 | ❌ 无 | Chat-first 限制 |
| **CodeClaw** | ✅ 核心 | ✅ 可选 Skill | **恰好** |

---

### 2. 核心架构：Unix 微内核

三层严格隔离，Kernel 只做路由和调度。

```
┌─────────────────────────────────────────┐
│  Channels (Telegram, Discord, Web...)   │  ← 用户接触面
├─────────────────────────────────────────┤
│  Skills (独立进程, host 运行)            │  ← 通道适配 + 工具服务
├─────────────────────────────────────────┤
│  Kernel (host 进程)                     │  ← 消息路由 + 容器调度 + 健康监控
├─────────────────────────────────────────┤
│  Agent (Docker 容器)                    │  ← Claude Code SDK, 完整 OS 能力
│  └── Workspace (持久 volume)            │  ← Agent 的"家"
└─────────────────────────────────────────┘
```

**Kernel 的职责边界**（微内核法则：Kernel 只做必须由 Kernel 做的事）：
- ✅ 消息路由：channel → Agent，Agent → channel
- ✅ 容器生命周期：启动、停止、健康检查
- ✅ Skill 注册表：谁在提供什么 channel
- ❌ 不做：消息语义理解、Skill 安装逻辑、安全审批、记忆管理

**参考项目对比**：
| | 架构风格 | 核心代码量 | 判断 |
|---|---|---|---|
| NanoClaw | 微内核 | ~7K 行 | 太薄，无 Skill 抽象 |
| TinyClaw | 插件单体 | ~28K 行 | 无进程隔离 |
| OpenClaw | 网关单体 | ~884K 行 | 不可维护 |
| **CodeClaw** | 微内核 + Skill | 目标 <15K 行 | **恰好** |

---

### 3. Skill 体系：Agent 自己装，不需要人类

这是 CodeClaw 最锐利的差异化点。所有扩展功能都是 Skill，但 Skill 有两种形态：

**通道 Skill（Channel Skill）**：
- 需要持续运行的独立进程（监听外部平台消息）
- 例：Telegram bot、Discord bot、Web server
- 向 Kernel 注册，提供 inbound/outbound 消息桥接
- 由 Agent 编写代码 + 启动进程 + 注册

**工具 Skill（Tool Skill）**：
- 不需要独立进程，Agent 自己写脚本/函数直接调用
- 例：天气查询、翻译、计算、文件处理
- 不需要向 Kernel 注册——Agent 用 Bash/代码直接执行
- 本质上就是 Agent workspace 里的代码

**"Agent 自己装" 的完整流程**：
```
用户 (Telegram): "帮我加一个每日天气推送"

Agent 思考：
  1. 这需要一个定时任务 + 天气 API 调用
  2. 天气查询 = 工具 Skill (写个脚本就行)
  3. 定时推送 = 利用 cron 或 Agent 自身的定时能力

Agent 行动：
  1. 写 /workspace/skills/weather.ts
  2. 测试：tsx weather.ts --city=Shanghai
  3. 设置定时任务
  4. 回复用户："搞定了，每天早上 8 点推送上海天气。"
```

**关键洞察**（来自 NanoClaw）：对于拥有 Claude Code 能力的 Agent，**写代码就是最自然的配置方式**。不需要设计复杂的"Skill 安装协议"——Agent 本身就是开发者。

**参考项目对比**：
| | 扩展方式 | 谁来安装 | 判断 |
|---|---|---|---|
| NanoClaw | 改源码 | Claude Code（间接） | 洞察对，但太粗暴 |
| TinyClaw | 对话式配对安装 | 人类（通过聊天） | 还是人类在装 |
| OpenClaw | 配置文件 + 插件加载 | 人类（编辑 53+ 配置） | 最传统最痛苦 |
| **CodeClaw** | Agent 写代码+启动 | Agent 自己 | **最自然** |

---

### 4. Code-first UX：看得见的思考

Agent 通过写代码、执行命令来完成任务，而不是把所有能力堆进 system prompt。但 code-first 的延迟问题通过**思考链流式输出**来解决。

**核心机制**：Telegram 消息编辑（`editMessageText`）

Agent 执行复杂任务时，用户看到的是一条不断更新的消息：

```
🔍 正在读取 config.yaml...
```
→
```
🔍 读取了 config.yaml
📝 正在修改端口配置...
```
→
```
✅ 已将端口从 3000 改为 8080，测试通过。
```

**为什么这比 Chat-first 好**：
- Chat-first（OpenClaw）：把所有工具描述塞进 system prompt → 16 万 token 上下文 → 推理空间被压缩 → 能力反而弱
- Code-first（CodeClaw）：Agent 拥有真实的文件系统和 CLI → 工具能力无上限 → 流式展示过程 → 用户不觉得慢

**实现要点**：
- SDK `query()` 已流式输出工具调用事件，数据源已有
- 需要 `send_message` 之外的 "progress update" 通道：编辑同一条消息而非发新消息
- Telegram bot 编辑频率需做节流（~1 次/秒）

**参考项目对比**：
| | 执行模式 | 过程可见性 | 判断 |
|---|---|---|---|
| NanoClaw | Code-first | ❌ 无 | 黑盒 |
| TinyClaw | Chat-first | ⚠️ 简单状态 | 能力弱 |
| OpenClaw | Chat-first | ❌ 无 | 黑盒且慢 |
| **CodeClaw** | Code-first + 流式展示 | ✅ 实时思考链 | **最佳 UX** |

---

### 5. 安全模型：约束 + 审批

Docker 隔离是地基，但不够。需要在隔离之上增加**约束层**和**审批层**。

**三层安全**：

```
Layer 1: Docker 隔离 (进程/文件系统/网络边界)
    ↓
Layer 2: 约束白名单 (Agent 能做什么)
    ↓
Layer 3: 交互式审批 (危险操作需人类确认)
```

**Layer 1 — Docker 隔离**（已有）：
- 非 root 用户运行
- 工作空间通过 volume 挂载
- 网络访问通过代理

**Layer 2 — 约束白名单**（待实现）：
- 出站白名单：Agent 能向哪些 channel/conversation 发消息
- 挂载白名单：Agent 能访问哪些目录
- 网络白名单：Agent 能访问哪些外部域名/IP
- 存储在容器外（Kernel 级配置），Agent 无法修改自己的约束

**Layer 3 — Emoji 审批**（待实现）：
- Agent 遇到超出约束的操作 → 发 Telegram 消息请求审批
- Approver 白名单中的用户 react 👍 → 批准，👎 → 拒绝
- 超时（N 分钟无人审批）→ 自动拒绝并通知
- 实现为 Skill 而非内核功能（"approval-gateway" Skill）

**为什么用 Emoji 而不是文字**：
- 零打字成本，一个点击
- 不污染聊天历史（reaction 不是独立消息）
- 群聊中不打断其他对话

**参考项目对比**：
| | 隔离 | 约束 | 审批 | 判断 |
|---|---|---|---|---|
| NanoClaw | ✅ Docker | ✅ 白名单 | ❌ 无 | 无审批 |
| TinyClaw | ❌ 无 | ⚠️ Shield | ✅ 文字审批 | 无隔离 |
| OpenClaw | ❌ 无 | ✅ RBAC | ✅ 执行审批 | 过于复杂 |
| **CodeClaw** | ✅ Docker | ✅ 白名单 | ✅ Emoji 审批 | **三层完整** |

---

## 与参考项目的关系总结

**从 NanoClaw 借鉴**：
- ✅ "写代码就是配置" 的洞察 → 融入 Skill 体系
- ✅ 白名单安全模型 → 融入安全 Layer 2
- ❌ 丢弃：无 Skill 抽象、轮询架构

**从 TinyClaw 借鉴**：
- ✅ 对话式审批的交互模式 → 升级为 Emoji 审批
- ✅ 时间衰减记忆评分公式 → 未来记忆系统参考
- ✅ 种子人格的简洁性 → 作为可选 Skill 参考
- ❌ 丢弃：自有 Agent Loop（Claude SDK 更强）、无容器隔离、单进程架构

**从 OpenClaw 借鉴**：
- ✅ Adapter 模式的通道抽象 → 参考 Channel Skill 接口设计
- ✅ Hook 系统的扩展点设计 → 未来 Kernel 事件系统参考
- ❌ 丢弃：Chat-first、配置爆炸、代码膨胀

---

## 设计原则清单

1. **Kernel 只做路由** — 消息进来，消息出去，容器活着。其他一切交给 Agent 和 Skill。
2. **Agent 是开发者** — 扩展功能不靠插件协议，靠 Agent 自己写代码。
3. **存在感 > 人格** — 记忆、主动行为、工作连续性是核心；性格参数是装饰。
4. **看得见的思考** — 流式展示工具调用链，不做黑盒。
5. **三层安全** — 隔离是地基，约束是围墙，审批是门禁。
6. **两种 Skill** — 通道 Skill 是独立进程（持续监听），工具 Skill 是 Agent 写的代码（按需调用）。
7. **代码量即技术债** — 目标 <15K 行核心代码。如果一个功能让代码量翻倍，它不应该在核心里。
