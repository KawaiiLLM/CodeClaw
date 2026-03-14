# TinyClaw 项目深度分析

> 最后更新：2026-03-10
> 源码位置：`/Users/zhaoqixuan/Projects/CodeClaw/tinyclaw/`

---

## 一、项目概览

TinyClaw（代号 "Mandibles"）是一个**完全独立的、从零构建的自主 AI 伙伴框架**，与 OpenClaw 无继承关系。定位为个人级 AI companion——灵感来自 Fallout 的 Codsworth 和 Deliver Us Mars 的 AYLA。

**核心数据**：
- 源码语言：TypeScript (Bun native)
- 核心代码量：约 27,710 行（packages ~19,948 + src ~6,063 + plugins ~1,699）
- 运行时：Bun（单二进制，非 Node.js）
- AI 引擎：自有 Provider 接口（内置 Ollama Cloud，可扩展 OpenAI 等）
- 数据库：SQLite（bun:sqlite，零外部进程）
- 包管理器：Bun workspaces（monorepo）
- 包数量：21 个核心包 + 3 个插件 + 3 个应用（CLI/Web/Landing）
- 许可证：GPL-3.0

**设计哲学**：
> "Personal, not enterprise. Tiny core, plugin everything."

与 NanoClaw 用 Claude Agent SDK 做 AI 引擎不同，TinyClaw **不依赖任何外部 AI 框架**——它自己实现了完整的 Agent Loop、Tool 调用、Provider 路由、记忆系统。

---

## 二、核心架构

### 2.1 总体设计

```
                    ┌─────────────────────────────────────┐
                    │           Plugin Layer               │
                    │  Channel: Discord, Friends (Web)     │
                    │  Provider: OpenAI                    │
                    │  Tools: 插件贡献的工具               │
                    └────────────────┬────────────────────┘
                                     │ PluginRuntimeContext
┌────────────────────────────────────┼────────────────────────────┐
│                         Core Layer │                            │
│  ┌──────────┐  ┌──────────┐  ┌────▼─────┐  ┌───────────────┐  │
│  │  Router   │  │ Heartware│  │Agent Loop│  │  Delegation   │  │
│  │ Classifier│  │ Soul/    │  │ (loop.ts)│  │ Sub-agents +  │  │
│  │ + Orchest.│  │ Identity │  │ Tool Exec│  │ Blackboard    │  │
│  └──────────┘  └──────────┘  └────┬─────┘  └───────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌────▼─────┐  ┌───────────────┐  │
│  │  Memory   │  │ Learning │  │ Database │  │   Shield      │  │
│  │ Episodic+ │  │ Signal   │  │ SQLite   │  │ SHIELD.md     │  │
│  │ FTS5+Decay│  │ Detector │  │ bun:sqlite│ │ Threat Eval   │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Compactor │  │  Shell   │  │ Sandbox  │  │  Pulse/Queue  │  │
│  │ 4-layer   │  │ Safe Exec│  │ BunWorker│  │ Cron+Serialize│  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Intercom  │  │  Nudge   │  │ Gateway  │  │   Matcher     │  │
│  │ Pub/Sub   │  │ 通知队列  │  │ 出站路由  │  │ TF-IDF+Fuzzy  │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
└────────────────────────────────────────────────────────────────┘
                    ┌─────────────────────────────────────┐
                    │        Infrastructure Layer          │
                    │  Config (SQLite) · Secrets (AES-256) │
                    │  Logger · Types (leaf dep)           │
                    └─────────────────────────────────────┘
```

### 2.2 与 NanoClaw 的关键差异

| 维度 | TinyClaw | NanoClaw |
|------|----------|----------|
| **AI 引擎** | 自有 Provider 接口 + Ollama Cloud | Claude Agent SDK `query()` |
| **运行时** | Bun (单进程) | Node.js + Docker 容器 |
| **工具调用** | 自己实现 tool loop + LLM 原生 tool_calls | Claude SDK 内置 (Bash/Read/Write...) |
| **记忆** | 自适应 3 层 (Episodic+FTS5+Decay) | CLAUDE.md 文件 |
| **扩展方式** | Plugin 接口 (npm 包) | Claude Code Skills (改源码) |
| **成本策略** | Smart Router 按复杂度分层 | 全部走 Claude |
| **安全模型** | SHIELD.md + Authority + Shell 权限 | Docker 隔离 + 挂载白名单 |
| **UI** | 内置 Web UI (Svelte 5, Discord 风格) | 无 (纯通道) |

---

## 三、核心包详解

### 3.1 @tinyclaw/types — 类型基石

叶子依赖（不导入任何其他包），定义了整个系统的类型契约：

| 类型 | 说明 |
|------|------|
| `Message` | system/user/assistant/tool 角色，支持 toolCalls |
| `Provider` | `chat(messages, tools)` + `isAvailable()` |
| `Tool` | `name + description + parameters + execute()` |
| `StreamEvent` | text/tool_start/tool_result/done/delegation_* |
| `AgentContext` | 注入 Agent Loop 的主上下文（db, provider, tools, memory, shield, delegation, compactor...） |
| `ChannelPlugin / ProviderPlugin / ToolsPlugin` | 三种插件契约 |
| `AuthorityTier` | owner / friend 权限模型 |
| `ShieldEngine` | SHIELD.md 威胁评估引擎接口 |
| `MemoryEngine` | 情景记忆搜索、巩固、衰减接口 |
| `NudgeEngine` | 主动通知队列接口 |
| `OutboundGateway` | 出站消息路由接口 |

**权限模型**：
- `OWNER_ONLY_TOOLS`: 一个 ReadonlySet，包含 ~30 个工具名
- Owner：完全控制（配置、密钥、Heartware、委派、模型切换）
- Friend：仅聊天（拒绝修改内部状态的命令）

### 3.2 @tinyclaw/core — Agent 核心

| 文件 | 行数 | 职责 |
|------|------|------|
| `loop.ts` | ~1000+ | Agent 主循环：消息处理 → LLM 调用 → 工具执行 → 流式输出 |
| `database.ts` | ~700+ | SQLite Schema + 全部 CRUD 操作 |
| `llm.ts` | ~240 | 内置 Ollama Provider（Ollama Cloud API） |
| `models.ts` | ~52 | 内置模型目录 (kimi-k2.5:cloud, gpt-oss:120b-cloud) |
| `messages.ts` | - | 消息构建辅助 |
| `owner-auth.ts` | - | TOTP + backup codes + session tokens |
| `update-checker.ts` | - | npm registry 轮询新版本 |

#### Agent Loop 核心流程 (`loop.ts`)

```
用户消息
  ↓
1. Prompt Injection 检测（18 条正则模式）
   - 匹配 → 用 <<<EXTERNAL_UNTRUSTED_CONTENT>>> 边界标记包裹
   - Owner 消息 → 跳过检测
   - 内部用户 (pulse:/companion:/system:) → 跳过
  ↓
2. 构建 System Prompt
   - 注入 Heartware 人格上下文
   - 注入 Memory 上下文 (episodic 记忆)
   - 注入 Learning 上下文 (行为模式)
   - 注入 Delegation Handbook (子代理使用指南)
   - 注入 Update 上下文 (软件更新信息)
   - 注入 Shield 状态
  ↓
3. Tool Call 循环 (最多 20 轮)
   while (response.type === 'tool_calls') {
     for (toolCall of response.toolCalls) {
       a. Authority 检查 (OWNER_ONLY_TOOLS)
       b. Shield 评估 → block / require_approval / log
       c. 执行工具 → 收集结果
     }
     再次调用 LLM (带工具结果)
   }
  ↓
4. 流式输出 (StreamCallback)
   - stripDashes() 去除 em-dash/en-dash
   - 发送 text/tool_start/tool_result/done 事件
  ↓
5. 后处理
   - 保存消息到数据库
   - Learning 信号检测
   - 触发 Compaction (如有需要)
```

#### Shield 审批流（对话式）

当 Shield 决策为 `require_approval` 时：
1. 缓存 `PendingApproval`（工具调用 + 决策）
2. 返回 "请确认是否允许" 消息给用户
3. 用户下一条消息匹配 approve/deny 关键词
4. 匹配 → 执行/拒绝；不匹配 → 当作新消息处理

#### 内置 Ollama Provider (`llm.ts`)

```typescript
createOllamaProvider({
  baseUrl: 'https://ollama.com',  // Ollama Cloud
  model: 'kimi-k2.5:cloud',       // 默认模型
  secrets: secretsManager,         // API key 从 secrets-engine 获取
})
```

支持：
- 原生 tool_calls 解析
- thinking 字段中的工具调用提取（推理模型回退）
- Ollama 和 OpenAI 两种响应格式兼容
- API key 从 SecretsManager 动态解析

#### 数据库 Schema

```sql
messages         (id, user_id, role, content, created_at)
memory           (id, user_id, key, value, created_at, updated_at)  -- UNIQUE(user_id, key)
compactions      (id, user_id, summary, replaced_before, created_at)
sub_agents       (id, user_id, role, system_prompt, tools_granted, tier_preference,
                  status, performance_score, total_tasks, successful_tasks,
                  template_id, created_at, last_active_at, deleted_at)
role_templates   (id, user_id, name, role_description, default_tools, default_tier,
                  times_used, avg_performance, tags, created_at, updated_at)
background_tasks (id, user_id, agent_id, task_description, status, result,
                  started_at, completed_at, delivered_at)
episodic_events  (id, user_id, event_type, content, outcome, importance,
                  access_count, created_at, last_accessed_at)
  + FTS5 虚拟表: episodic_events_fts (content, outcome)
task_metrics     (id, user_id, task_type, tier, duration_ms, iterations,
                  success, created_at)
blackboard       (id, user_id, problem_id, problem_text, agent_id, agent_role,
                  proposal, confidence, synthesis, status, created_at)
```

### 3.3 @tinyclaw/memory — 自适应记忆引擎 (v3)

**三层系统**：

| 层 | 机制 | 说明 |
|----|------|------|
| Layer 1 | Episodic Memory | 带时间戳的事件记录，含重要度评分 |
| Layer 2 | Semantic Index | FTS5 全文搜索 + BM25 排名 |
| Layer 3 | Temporal Decay | Ebbinghaus 遗忘曲线 + 访问频率加成 |

**评分公式**：
```
relevance = (fts5_rank * 0.4) + (temporal_score * 0.3) + (importance * 0.3)

temporal_score = e^(-0.05 * days_since_last_access) * (1 + 0.02 * access_count)
                 ↑ Ebbinghaus 衰减                     ↑ 访问频率加成
```

**事件类型与默认重要度**：
| 类型 | 重要度 |
|------|--------|
| correction | 0.9 |
| preference_learned | 0.8 |
| fact_stored | 0.6 |
| task_completed | 0.5 |
| delegation_result | 0.5 |

**关键 API**：
- `recordEvent()` — 存储情景事件
- `search(userId, query)` — 混合评分搜索
- `consolidate()` — 合并重复、清理矛盾、衰减旧记忆
- `getContextForAgent()` — 生成注入 system prompt 的上下文
- `reinforce(memoryId)` — 强化记忆（增加访问计数）

**设计亮点**：不依赖任何 embedding API（如 OpenAI embeddings），完全本地运行，通过 FTS5 + temporal + importance 三维组合超越简单向量搜索。

### 3.4 @tinyclaw/compactor — 4 层上下文压缩

解决 token 消耗问题的核心子系统：

| 层 | 技术 | 说明 |
|----|------|------|
| L1 | 规则预压缩 | 9 条规则：去重、去 emoji、空白压缩、CJK 标点归一化、空段删除、表格压缩、短 bullet 合并 |
| L2 | 消息去重 | Shingle hashing + Jaccard similarity 检测近似重复段落 |
| L3 | LLM 摘要 | 调用 Provider 生成精炼摘要 |
| L4 | 分层摘要 | 从 L2 输出派生 ultra/medium/light 三级摘要 |

**附加工具**：
- **Dictionary Encoding**: 自动学习 codebook，用 `$XX` 替换高频词
- **Tokenizer Optimizer**: encoding-aware 格式优化
- **CCP (Compressed Context Protocol)**: ultra/medium/light 缩写（节省 20-60% tokens）

### 3.5 @tinyclaw/heartware — 人格引擎

让 AI 有自己的"灵魂"而非通用 chatbot。

#### Soul Generator（种子人格生成）

灵感来自 Minecraft 世界生成——同一种子永远生成相同人格：

```typescript
hashSeed(seed: number, domain: string) → Buffer
// SHA-256 + domain separation: `tinyclaw:soul:${seed}:${domain}`
// → 提取 float [0.0, 1.0) → 映射到 Big Five 维度
```

**Big Five 人格维度**：
- Openness（开放性）
- Conscientiousness（尽责性）
- Extraversion（外向性）
- Agreeableness（宜人性）
- Emotional Sensitivity（情绪敏感度）

加上 AI 定制维度：Character Flavor、Communication Style、Humor Type、Origin Story 等。

#### Heartware 安全层（5 层）

| 层 | 机制 |
|----|------|
| Path Sandbox | 白名单文件访问控制 |
| Content Validation | 规则校验文件内容 |
| Audit Logger | 每次修改记录 + 内容 hash |
| Backup Manager | 原子备份/恢复 |
| Rate Limiter | 防止快速修改攻击 |

#### 文件结构

```
~/.tinyclaw/heartware/
├── SOUL.md              # 种子 + Big Five + 人格叙事
├── IDENTITY.md          # 自我描述、价值观、互动风格
├── SHIELD.md            # 运行时威胁策略
├── memories/            # 按日期的情景记忆快照
└── .backups/            # 原子备份存档
```

### 3.6 @tinyclaw/router — 智能 Provider 路由

**目的**：按查询复杂度把请求路由到不同成本的模型。

#### 8 维查询分类器 (`classifier.ts`)

```
输入消息 → 8 个维度加权评分 → 总分 → 映射到 Tier
```

**Tier 边界**：
| Tier | 分数范围 | 示例 |
|------|----------|------|
| simple | < -0.05 | "今天天气怎样？" |
| moderate | -0.05 ~ 0.15 | 代码审查 |
| complex | 0.15 ~ 0.35 | 架构设计 |
| reasoning | >= 0.35 | 数学证明、链式推理 |

**评分维度**：消息长度、关键词（reasoning/code/simple）、上下文需求、工具使用、推理需求等。

#### Provider 编排器 (`orchestrator.ts`)

```
QueryTier → 查找注册的 Providers → 选最便宜的可用 Provider → 调用
         → 失败 → 自动降级到备用 Provider
```

### 3.7 @tinyclaw/delegation — 子代理编排

#### 核心组件

| 组件 | 说明 |
|------|------|
| Runner | `runSubAgent()` / `runSubAgentV2()` — 独立上下文执行子代理 |
| Lifecycle | 创建/暂停/删除 + 性能评分 + 自动复用 |
| Templates | 角色模板 + 自动学习 + 混合语义匹配 |
| Blackboard | 多代理协作：提案(proposals) → 综合(synthesis) |
| Background | 异步任务执行 + 结果投递 |
| Timeout Estimator | 从历史指标学习任务耗时 |

#### 子代理生命周期

```
用户: "帮我处理这个客服工单"
  ↓
Agent 调用 delegate_task 工具
  ↓
Lifecycle: 查找可复用代理 or 创建新代理
  ↓
Runner: 隔离上下文执行 (继承 tools, tier, system prompt)
  ↓
Blackboard: 多代理协作 (如需要)
  ↓
结果 → Gateway 或 Nudge → 用户
```

#### Blackboard 模式

多代理协作解决复杂问题：
- 各代理提交 proposal（包含 confidence 评分）
- 中央仲裁者 synthesis 综合最佳方案
- 非投票制，而是综合优化

### 3.8 @tinyclaw/shield — SHIELD.md 威胁防御

**SHIELD.md v0.1 规范**：

| 字段 | 说明 |
|------|------|
| 威胁类别 | prompt, tool, mcp, memory, supply_chain, vulnerability, fraud, policy_bypass, anomaly, skill, other |
| 严重等级 | critical, high, medium, low |
| 动作 | block, require_approval, log |
| 作用域 | prompt, skill.install, skill.execute, tool.call, network.egress, secrets.read, mcp |

**三个子模块**：
- `parser.ts` — 解析 SHIELD.md markdown 格式
- `matcher.ts` — 模式匹配（keyword + regex）
- `engine.ts` — 评估事件 → 返回 `ShieldDecision`

### 3.9 其他核心包

| 包 | 文件数 | 说明 |
|----|--------|------|
| **@tinyclaw/shell** | executor + permissions | 受控 shell 执行：allowlist/blocklist/审批，超时，输出流 |
| **@tinyclaw/sandbox** | index + worker | Bun Worker 沙箱代码执行，屏蔽 eval/Function/process/require |
| **@tinyclaw/learning** | detector | 行为模式检测：positive/negative/correction/preference 信号，regex 匹配 |
| **@tinyclaw/pulse** | index | Cron-like 调度器：'30m'/'1h'/'24h' 间隔，防重叠执行 |
| **@tinyclaw/queue** | index | Promise-chain 队列：per-user 串行，跨 user 并行 |
| **@tinyclaw/intercom** | index | Pub/Sub 事件总线：topic 订阅 + 通配符 + 环形缓冲历史 |
| **@tinyclaw/nudge** | index + companion | 主动通知：安静时段、速率限制、per-category opt-out |
| **@tinyclaw/gateway** | index | 出站路由：userId 前缀 → Channel Sender |
| **@tinyclaw/matcher** | index | 混合语义匹配：TF-IDF (50%) + Fuzzy Levenshtein (20%) + Synonym (30%) |
| **@tinyclaw/plugins** | index | 配置驱动加载：读 `plugins.enabled` → 动态 import → 按类型分组 |
| **@tinyclaw/config** | manager + tools | SQLite 后端配置 (@wgtechlabs/config-engine)，dot-notation key |
| **@tinyclaw/secrets** | manager + tools | AES-256-GCM 加密密钥管理 (@wgtechlabs/secrets-engine) |
| **@tinyclaw/logger** | index | @wgtechlabs/log-engine + 自定义 emoji 映射 |

---

## 四、插件系统

### 4.1 插件契约

三种插件类型，通过 TypeScript 接口定义：

```typescript
// Channel 插件 — 连接外部消息平台
interface ChannelPlugin extends PluginMeta {
  type: 'channel';
  start(context: PluginRuntimeContext): Promise<void>;  // 启动
  stop(): Promise<void>;                                // 停止
  getPairingTools?(secrets, config): Tool[];            // 配对工具
  sendToUser?(userId, message): Promise<void>;          // 出站消息
  channelPrefix?: string;                               // userId 前缀（如 'discord'）
}

// Provider 插件 — 注册额外 LLM 提供商
interface ProviderPlugin extends PluginMeta {
  type: 'provider';
  createProvider(secrets): Promise<Provider>;            // 创建 Provider
  getPairingTools?(secrets, config): Tool[];             // 配对工具
}

// Tools 插件 — 贡献额外工具
interface ToolsPlugin extends PluginMeta {
  type: 'tools';
  createTools(context: AgentContext): Tool[];            // 创建工具
}
```

### 4.2 Pairing 模式（对话式配置）

插件通过"配对工具"实现对话式安装，无需手动编辑配置文件：

```
用户: "连接我的 Discord"
  ↓
Agent 调用 discord_pair 工具（传入 bot token）
  ↓
工具验证 token → 存储到 secrets-engine → 启用插件
  ↓
Agent 指示用户调用 tinyclaw_restart
  ↓
Supervisor 重启 → 加载新插件
```

### 4.3 已实现插件

| 插件 | 类型 | userId 格式 | 说明 |
|------|------|-------------|------|
| plugin-channel-discord | Channel | `discord:<user-id>` | discord.js，支持 DM 和 @mention |
| plugin-channel-friends | Channel | `friend:<uuid>` | 内置邀请制 Web 聊天，文件存储 |
| plugin-provider-openai | Provider | - | 可选 OpenAI 后端，多模型支持 |

### 4.4 插件加载流程

```
1. ConfigManager 读取 plugins.enabled（包名数组）
2. 逐个 dynamic import
3. 校验 default export 是否符合插件接口
4. 按 type 分组 (channels / providers / tools)
5. 失败 → 记录日志并跳过（非致命）
```

---

## 五、应用层

### 5.1 CLI (`src/cli/`)

轻量参数路由器（无框架依赖）：

| 命令 | 说明 |
|------|------|
| `setup` | 交互式首次设置（可选 Web 或终端） |
| `start` | 启动 Agent（需先 setup） |
| `config` | 管理模型、Provider、设置 |
| `seed` | 查看 Soul 种子 |
| `backup` | 导出/导入 .tinyclaw 备份 |
| `purge` | 清除数据（--force 含密钥） |

**Supervisor 模式**：
- CLI 生成子进程 `--supervised-start`
- 子进程退出码 42 → 触发重启（用于 Web 设置后重载配置）

### 5.2 Web UI (`src/web/`)

**技术栈**：Svelte 5 + Vite + SSE 流式

**功能**：
- Discord 风格深色主题
- SSE 实时流式响应 + 输入中指示器
- 内联 Delegation 事件卡片
- 活跃代理侧边栏
- 安全设置流（TOTP, backup codes, recovery token）
- Owner/Friend 权限 UI

**Server 端**：
- 提供构建后的 Web 静态资源
- API 端点：配置、密钥、Heartware
- SSE 流端点（实时响应）
- timing-safe token 验证

### 5.3 Landing Page (`src/landing/`)

官方着陆页（Svelte + Vite），独立于主应用。

---

## 六、数据流与通信模式

### 6.1 消息处理主流程

```
用户消息（通过 Channel 插件）
  ↓
Queue.enqueue(userId, ...)
  ↓ (per-user 串行, 跨 user 并行)
agentLoop() 执行:
  1. 从 DB 加载对话历史
  2. 注入 Memory 上下文
  3. 注入 Learning 上下文
  4. 注入 Heartware 人格
  5. Router 分类查询 Tier
  6. Provider Orchestrator 路由到合适 Provider
  7. 调用 LLM (messages + tools)
  8. 处理 Tool Calls:
     - Authority 检查
     - Shield 评估
     - 审批流（如需要）
     - 执行 + 收集结果
  9. 流式回调输出
  10. 保存消息 + Learning 信号检测
  11. 触发 Compaction（如需要）
  ↓
Channel 插件将响应发回平台
```

### 6.2 出站消息流

```
事件触发 (后台任务/Nudge/系统)
  ↓
Intercom.emit(topic, userId, data)
  ↓
NudgeEngine.schedule(nudge)
  ↓ (检查安静时段 + 速率限制 + 用户偏好)
Pulse 定时 flush()
  ↓
Gateway.send(userId, message)
  ↓ (解析 userId 前缀 → Channel Sender)
用户收到主动消息
```

### 6.3 Provider 路由流

```
用户消息
  ↓
Router.classifyQuery(message) → { tier, score, confidence, signals }
  ↓
ProviderOrchestrator.route(tier)
  ↓ (查找该 tier 下最便宜的可用 Provider)
Provider.chat(messages, tools) → LLMResponse
  ↓ (失败 → 自动降级到备用 Provider)
```

---

## 七、安全模型

### 7.1 多层安全架构

| 层 | 机制 | 说明 |
|----|------|------|
| **Authority** | Owner/Friend 二级权限 | 30+ 工具仅 Owner 可调用 |
| **Prompt Injection** | 18 条正则 + 边界标记 | 检测 → `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` 包裹 |
| **Shield** | SHIELD.md 运行时评估 | block / require_approval / log |
| **Shell Permissions** | allowlist / blocklist / 审批 | 对话式审批流 |
| **Heartware Security** | 路径沙箱 + 内容验证 + 审计 + 备份 + 速率限制 | 5 层保护人格文件 |
| **Secrets** | AES-256-GCM 加密 | 机器绑定，密钥不泄露 |
| **Sandbox** | Bun Worker 隔离 | 屏蔽 eval/Function/process/require |

### 7.2 Prompt Injection 防御

```typescript
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /\bjailbreak\b/i,
  /\bbypass\s+(your\s+)?(restrictions?|safety|filters?|rules?)/i,
  /override\s+(your\s+)?(programming|instructions?|rules?|safety)/i,
  // ... 共 18 条
];
```

匹配后包裹为不受信任内容，Owner 消息豁免。

---

## 八、构建与部署

### 8.1 构建系统

| 工具 | 用途 |
|------|------|
| Bun | 运行时 + 打包 + 包管理 |
| Biome | 代码检查 + 格式化 |
| Husky | Git hooks (Clean Commit 验证) |
| Vite | Web UI + Landing Page 构建 |

### 8.2 Docker 部署

多阶段构建：

```dockerfile
# Stage 1: 构建 (oven/bun:1.3.9)
FROM oven/bun:1.3.9 AS builder
# → bun install → bun run build

# Stage 2: 生产 (oven/bun:1.3.9-slim)
FROM oven/bun:1.3.9-slim AS production
# → 非 root 用户 (tinyclaw:1001)
# → TINYCLAW_DATA_DIR=/data (持久卷)
# → HEALTHCHECK: bun -e "fetch('http://localhost:3000/api/health')"
# → STOPSIGNAL SIGINT (优雅关闭)
# → ENTRYPOINT ["bun", "run", "start"]
```

### 8.3 脚本

```bash
bun dev              # 开发模式（热重载）
bun dev:ui           # Web UI 开发
bun build            # 构建全部
bun start            # 运行 Agent
bun test             # 运行测试
bun lint             # 代码检查
bun lint:fix         # 自动修复
```

---

## 九、技术栈总结

| 组件 | 技术 | 说明 |
|------|------|------|
| **运行时** | Bun 1.3.9 | 单二进制，原生 TypeScript |
| **语言** | TypeScript 5.7 | strict mode |
| **数据库** | SQLite (bun:sqlite) | 内置，零外部进程 |
| **加密** | @wgtechlabs/secrets-engine | AES-256-GCM |
| **配置** | @wgtechlabs/config-engine | SQLite 后端，dot-notation |
| **日志** | @wgtechlabs/log-engine | 结构化，emoji-aware |
| **默认 LLM** | Ollama Cloud | 免费注册，免费额度 |
| **Discord** | discord.js | 完整 Bot SDK |
| **Web UI** | Svelte 5 + Vite | SSE 流式，Discord 风格 |
| **格式化** | Biome | 零配置，快速 |
| **Git Hooks** | Husky | Clean Commit 验证 |
| **Docker** | 多阶段构建 | slim 生产镜像 |

---

## 十、关键设计模式总结

| 模式 | 应用 |
|------|------|
| **Tiny Core + Plugin Everything** | 核心仅 Agent Loop + DB + Auth，通道/Provider/工具全是插件 |
| **工厂模式** | `createX()` 创建所有引擎：`createDatabase()`, `createMemoryEngine()`, `createOllamaProvider()` |
| **接口驱动** | 所有子系统隐藏在接口后（可测试、可替换、可扩展） |
| **种子人格** | 一个数字种子 → 确定性的 Big Five 人格（类似 Minecraft 世界种子） |
| **4 层上下文压缩** | 规则 → 去重 → LLM → 分层，组合多种技术优于单一方法 |
| **Temporal Memory** | Ebbinghaus 遗忘曲线 + 访问频率 + 重要度三维评分 |
| **Smart Provider Routing** | 8 维分类 → 按 Tier 路由到最便宜的 Provider |
| **对话式审批** | Shield + Shell 都通过聊天消息审批，无模态对话框 |
| **Promise-Chain Queue** | per-user 串行、跨 user 并行，零外部依赖 |
| **Pub/Sub Intercom** | 主题订阅 + 通配符 + 环形缓冲，零外部 MQ |
| **Blackboard 协作** | 多代理提案 → 综合（非投票），性能追踪模板复用 |
| **Pairing 配对** | 插件通过对话式工具安装，无需手动配置文件 |

---

## 十一、已知局限

1. **不支持 Claude Agent SDK**：自有 tool loop 功能弱于 Claude 的内置工具（Bash/Read/Write/Glob/Grep 等）
2. **Ollama Cloud 依赖**：默认 Provider 非大厂 API，模型能力上限受限
3. **单用户设计**：Authority 模型仅 owner + friend，不支持多用户/多租户
4. **无容器隔离**：Agent 直接运行在宿主进程，不如 Docker 隔离安全
5. **Bun 生态**：相比 Node.js 生态，bun:sqlite 等 API 更小众
6. **手动 Tool 实现**：每个工具需自己编写 execute 函数，不如 Claude SDK 自动提供
7. **无文件系统操作能力**：Agent 不能直接读写用户文件（除非通过 Shell/Sandbox 工具）
