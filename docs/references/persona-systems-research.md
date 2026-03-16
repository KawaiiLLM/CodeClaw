# Persona Systems 调研：NanoClaw / TinyClaw / OpenClaw

> 调研日期：2026-03-16
> 目的：了解同系列项目如何让 AI agent 维持人设/性格，为 CodeClaw 提供设计参考。

---

## 1. NanoClaw（最简单）

**没有独立的 persona 系统。**

人设仅是 `groups/global/CLAUDE.md` 中一段自然语言描述（"You are Andy, a personal assistant"），通过 Claude Agent SDK 的 `settingSources: ['project']` 机制自动加载到上下文。

- 无结构化定义
- 无生成机制
- 无自省能力
- 手动编辑 CLAUDE.md 即可"换人设"

---

## 2. TinyClaw（`@tinyclaw/heartware` 包）

### 核心理念：Minecraft 式种子生成 + 不可变灵魂

一个数字 seed 通过 SHA-256 + domain separation 确定性地生成完整性格。同一个 seed **永远**生成相同人格，用户可保存/分享 seed 复现。

### 文件矩阵（`~/.tinyclaw/heartware/`）

| 文件 | 用途 | 可变性 |
|------|------|--------|
| `SEED.txt` | 纯数字种子 | 不可变 |
| `SOUL.md` | 从种子生成的"灵魂"——性格、交流风格、价值观、怪癖、起源故事 | 不可变 |
| `IDENTITY.md` | 名字、emoji、生物形态、氛围 | 可变 |
| `FRIEND.md` | Owner 个人信息和偏好 | 可变 |
| `FRIENDS.md` | 非 owner 用户记录 | 可变 |
| `AGENTS.md` | 操作指南 | 可变 |
| `TOOLS.md` | 工具使用笔记 | 可变 |
| `SHIELD.md` | 安全策略（12 条威胁规则） | 可变 |
| `MEMORY.md` | 长期记忆 | 可变 |
| `BOOTSTRAP.md` | 首次运行引导对话 | 用完即删 |
| `CREATOR.md` | 远程拉取的创作者信息 | 自动刷新 |
| `memory/YYYY-MM-DD.md` | 每日记忆日志 | 可变 |

### SoulTraits 数据模型

```typescript
interface SoulTraits {
  seed: number;
  personality: BigFiveTraits;        // openness, conscientiousness, extraversion, agreeableness, emotionalSensitivity (各 0.0-1.0)
  communication: CommunicationStyle; // verbosity, formality, emojiFrequency (各 0.0-1.0)
  humor: HumorType;                  // 'none' | 'dry-wit' | 'playful' | 'punny'
  preferences: SoulPreferences;      // favoriteColor, favoriteNumber, favoriteSeason, favoriteTimeOfDay, greetingStyle
  character: CharacterFlavor;        // creatureType, signatureEmoji, catchphrase, suggestedName
  values: string[];                  // Top 3（从 12 选 3）
  quirks: string[];                  // 2-3 个行为怪癖（从 18 选）
  interactionStyle: InteractionStyle; // errorHandling, celebrationStyle, ambiguityApproach
  origin: OriginStory;              // originPlace, awakeningEvent, coreMotivation, firstMemory
}
```

种子生成机制：`seed + "tinyclaw:soul:{seed}:{domain}"` -> SHA-256 -> 4 字节 -> float -> 性格数值。零外部依赖，纯 `node:crypto`。

### 注入方式

1. `loadHeartwareContext(manager)` 按优先级拼装所有文件（SOUL > IDENTITY > FRIEND > ... > CREATOR）
2. 返回 `=== HEARTWARE CONFIGURATION ===` 包裹的大字符串
3. `getBaseSystemPrompt(heartwareContext)` 追加到 system prompt 末尾
4. 作为 `{ role: 'system', content: systemPrompt }` 传给 LLM

### 安全设计：五层安全栈

- Layer 1: Rate limiting
- Layer 2: Path sandboxing（白名单 + 防路径穿越）
- Layer 3: Content validation（阻止代码注入）
- Layer 4: Backup（写入前自动备份）
- Layer 5: Audit logging（每次操作记录 + 内容哈希）

`SOUL.md` 和 `SEED.txt` 在 `sandbox.ts` 中硬编码为 `IMMUTABLE_FILES`，agent 通过 heartware_write 工具无法修改。

### 关键设计模式

- **不可变灵魂 + 可变身份**：哲学上区分"我是谁"（SOUL，不可变）和"我叫什么"（IDENTITY，可变）
- **Agent 自省工具**：`soul_info` 和 `soul_explain` 让 agent 能回答"为什么我这么爱用 emoji"（回溯到 seed 生成的 emojiFrequency）
- **Bootstrap 孵化仪式**：首次对话中 AI 和用户一起"搞清楚我是谁"，完成后删除 BOOTSTRAP.md
- **Sub-agent 继承**：delegation 系统将 heartwareContext 截取最多 1600 字符注入 sub-agent 的 orientation prompt
- **Companion Nudge**：主动消息系统通过 mood roulette 生成消息，天然与 persona 对齐（因为复用了注入 heartware 的 agentLoop）

### 多 Persona

不支持。一个实例 = 一个 seed = 一个灵魂。想要不同 persona 需要不同实例。

### 关键文件

- `packages/heartware/src/types.ts` — 核心类型定义
- `packages/heartware/src/soul-generator.ts` — seed 到性格的生成逻辑
- `packages/heartware/src/soul-traits.ts` — 性格维度定义和候选池
- `packages/heartware/src/manager.ts` — 中央管理器（五层安全栈）
- `packages/heartware/src/loader.ts` — 上下文加载器
- `packages/heartware/src/tools.ts` — 11 个 agent 自我管理工具
- `packages/heartware/src/sandbox.ts` — 安全沙箱
- `packages/core/src/loop.ts` — agent loop 中 persona 注入点

---

## 3. OpenClaw（最完整）

### 核心理念：多文件分层 + 多 agent 路由 + 自我演进

"You're not a chatbot. You're becoming someone." — SOUL.md 开篇语。Persona 被设计为 agent 自己可以演进的东西，而非静态配置。

### 文件矩阵（每个 agent 独立 workspace）

| 文件 | 用途 | 定位 |
|------|------|------|
| `SOUL.md` | 性格灵魂：价值观、行事准则、语气、边界 | "Who You Are" — 最高层哲学 |
| `IDENTITY.md` | 结构化身份卡：name, creature, vibe, emoji, avatar | 可机器解析的元数据 |
| `USER.md` | 服务对象画像：用户名字、时区、偏好 | 关系定义 |
| `AGENTS.md` | 操作手册：会话启动流程、记忆规则、行为准则 | 运行时行为规范 |
| `BOOTSTRAP.md` | 首次启动仪式（用完即删） | 引导 agent "出生" |
| `TOOLS.md` | 工具使用备注 | 环境特定知识 |
| `MEMORY.md` | 长期记忆（仅主会话加载，群聊不注入） | 安全设计 |

### 注入方式：条件式激活

在 `system-prompt.ts` 的 `buildAgentSystemPrompt()` 中，所有 workspace 文件作为 `contextFiles` 注入 system prompt 的 `# Project Context` 区域。关键逻辑：

```typescript
const hasSoulFile = validContextFiles.some((file) => {
  const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
  return baseName.toLowerCase() === "soul.md";
});
if (hasSoulFile) {
  lines.push(
    "If SOUL.md is present, embody its persona and tone. "
    + "Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
  );
}
```

检测到 SOUL.md 存在时额外注入激活指令。

### IDENTITY.md 双重身份来源

- **Markdown 文件**（面向 agent）：自由格式，agent 在对话中自然形成
- **JSON IdentityConfig**（面向运行时）：结构化数据（name, theme, emoji, avatar），用于消息前缀、ACK emoji、头像
- 两者可通过 `openclaw agents identity set --from-identity` 命令同步

```typescript
// config/types.base.ts
export type IdentityConfig = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
};
```

### 多 Persona = 多 Agent + Bindings 路由

每个 agent 是完全隔离的人格（独立 workspace、session store、auth profiles）。通过 Bindings 路由：

```json5
{
  agents: {
    list: [
      { id: "chat", name: "Everyday", workspace: "~/.openclaw/workspace-chat", model: "anthropic/claude-sonnet-4-5" },
      { id: "opus", name: "Deep Work", workspace: "~/.openclaw/workspace-opus", model: "anthropic/claude-opus-4-6" },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

路由维度：channel / accountId / peer / Discord guild+role。

### 关键设计模式

- **Agent 自主演进 SOUL.md**：灵魂文件末尾写 "This file is yours to evolve. As you learn who you are, update it."。修改时必须通知用户。与 TinyClaw 的"不可变"设计形成鲜明对比。
- **Bootstrap "出生仪式"**：新 agent 首次对话被引导确定自己的身份，然后自己写入 IDENTITY.md 和 USER.md，完成后删除 BOOTSTRAP.md。
- **4 层前缀/反应级联**：ACK emoji 和 response prefix 支持 account > channel > global messages > agent identity emoji fallback 四级优先级。同一 persona 在不同渠道可展现不同"表面身份"。
- **记忆安全**：MEMORY.md 仅主会话加载，群聊不注入，防止私人记忆泄露。
- **Sub-agent 精简注入**：子 agent 只注入 AGENTS/TOOLS/SOUL/IDENTITY/USER，跳过 MEMORY/HEARTBEAT/BOOTSTRAP。
- **`agent:bootstrap` hook**：运行时可动态替换 bootstrap 文件，实现 persona 热切换。
- **Dev 模式专用 persona**：`--dev` 使用 SOUL.dev.md（C-3PO 角色）+ IDENTITY.dev.md。

### 关键文件

- `docs/reference/templates/SOUL.md` — 默认灵魂模板
- `docs/reference/templates/IDENTITY.md` — 默认身份卡模板
- `docs/reference/templates/BOOTSTRAP.md` — 出生仪式模板
- `src/agents/system-prompt.ts` — System prompt 组装（SOUL.md 检测与激活）
- `src/agents/identity-file.ts` — IDENTITY.md 解析器
- `src/agents/identity.ts` — 运行时 identity 解析（前缀、emoji、delay 等）
- `src/agents/workspace.ts` — Workspace 管理与 bootstrap 文件加载
- `src/agents/agent-scope.ts` — 多 agent 路由与配置解析
- `src/config/types.agents.ts` — AgentConfig 类型（含 identity 字段）
- `src/config/types.base.ts` — IdentityConfig 类型定义
- `src/commands/agents.commands.identity.ts` — CLI identity 设置命令

---

## 横向对比

| 维度 | NanoClaw | TinyClaw | OpenClaw |
|------|----------|----------|----------|
| 人设定义 | CLAUDE.md 一段话 | seed -> 结构化生成（Big Five 等） | 多 Markdown 文件（自由格式） |
| 注入方式 | SDK settingSources | system prompt 拼接 | system prompt contextFiles |
| 灵魂可变性 | 手动编辑 | 不可变（硬编码拦截） | 可演进（agent 自己改） |
| 多 persona | 不支持 | 不支持（一实例一灵魂） | 支持（多 agent + Bindings 路由） |
| 自省能力 | 无 | 有（soul_explain 回溯 seed） | 无 |
| 安全机制 | 无 | 五层安全栈 | hook 系统 |
| Bootstrap | 无 | 有（首次对话引导） | 有（出生仪式） |
| Owner 概念 | 无 | 有（FRIEND.md） | 有（USER.md） |

---

## 对 CodeClaw 的设计启示

CodeClaw 已有多 agent 架构（anon/sakiko）和 `~/CLAUDE.md` 注入机制。可参考的方向：

1. **最小可行方案**：参考 OpenClaw 的 SOUL.md + IDENTITY.md 分层，每个 agent 的 home 目录下放置人设文件，现有 SDK `settingSources` 或 `SDK_SYSTEM_APPEND` 自动加载。
2. **结构化身份**：参考 OpenClaw 的 IdentityConfig（name/emoji/avatar），用于消息前缀和 Telegram 交互。
3. **Bootstrap 机制**：参考 TinyClaw/OpenClaw 的首次对话引导，让 agent 在与用户的第一次交互中"诞生"。
4. **可变性决策**：TinyClaw 选择不可变灵魂（稳定性），OpenClaw 选择可演进灵魂（成长性）。CodeClaw 需要根据使用场景决定。
5. **记忆隔离**：参考 OpenClaw 的群聊不注入 MEMORY.md，防止跨会话隐私泄露。
