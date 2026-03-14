# Claude Code Plugin 系统参考

> 基于 Claude Code CLI 源码 + 实际插件逆向分析（2026-03-14）。

---

## 概念

Plugin 是一个自包含目录，可同时捆绑 Skills、MCP 服务器、Slash Commands、Agents 和 Hooks。类似 VS Code Extension，通过单一安装操作部署。

---

## 目录结构

```
plugin-root/
├── .claude-plugin/
│   ├── plugin.json          # 插件主清单（必须）
│   └── marketplace.json     # 分发清单（多插件包用，可选）
├── skills/                  # Skills（自动扫描）
│   └── <name>/SKILL.md
├── commands/                # Slash Commands（自动扫描）
│   └── <name>.md
├── agents/                  # Agent 定义（自动扫描）
│   └── <name>.md
├── hooks/
│   └── hooks.json           # 生命周期钩子（自动扫描）
├── .mcp.json                # MCP 服务器配置（自动扫描）
└── lib/                     # 辅助代码（不扫描）
```

**自动扫描规则**：Claude Code 在插件根目录自动检测 `skills/`、`commands/`、`agents/`、`output-styles/`、`hooks/hooks.json`、`.mcp.json`，无需在 plugin.json 中声明。仅非标准路径需要显式声明。

---

## plugin.json 清单格式

```jsonc
{
  "name": "my-plugin",            // 必填，kebab-case
  "version": "1.0.0",             // 可选，semver
  "description": "...",           // 可选
  "author": { "name": "...", "email": "...", "url": "..." },
  "homepage": "https://...",
  "repository": "https://...",
  "license": "MIT",
  "keywords": ["..."],

  // 组件声明（均可选，仅非标准路径时声明）
  "skills": "string | string[]",
  "commands": "string | string[] | Record<name, CommandMeta>",
  "agents": "string | string[]",
  "mcpServers": "string | InlineMCPConfig | Array<...>",
  "hooks": "string | HooksConfig | Array<...>",
  "settings": {}                  // 启用时注入的全局设置
}
```

极简示例（superpowers 4.3.0，完全依赖自动扫描）：

```json
{
  "name": "superpowers",
  "description": "Core skills library...",
  "version": "4.3.0",
  "author": { "name": "Jesse Vincent" },
  "license": "MIT"
}
```

---

## SKILL.md Frontmatter

```yaml
---
name: my-skill                      # 省略则用目录名
description: "Use when [触发条件]"   # 关键：注入 <available_skills> 列表
allowed-tools: Bash(git:*), Read     # 可选，执行时额外开放的工具
user-invocable: true                 # 可选，用户能否直接调用（默认 true）
disable-model-invocation: false      # 可选，true = 纯转发器，不启动模型
model: claude-sonnet-4-5             # 可选，"inherit" = 继承调用者
argument-hint: "[topic]"             # 可选
when_to_use: "补充触发描述"           # 可选
context: fork                        # 可选，"fork" = 独立上下文执行
agent: code-reviewer                 # 可选，关联 Agent 类型
---

# Skill 正文（Markdown）
```

**关键字段语义**：
- `description` 是一等公民 — 直接注入系统提示的技能列表，决定模型何时调用
- `allowed-tools` 支持 glob（如 `Bash(git:*)` 允许所有 git 子命令）
- `user-invocable: false` — 仅 Agent 内部可调用
- `${CLAUDE_SKILL_DIR}` — 正文中可用，运行时替换为 Skill 目录绝对路径

**命名空间**：Plugin Skill 命名为 `<plugin>:<skill-dir>`（如 `superpowers:brainstorming`），个人 Skill（`~/.claude/skills/`）无前缀。个人 Skill 优先于同名 Plugin Skill。

---

## MCP 服务器配置

三种声明方式：

**1. `.mcp.json` 文件（推荐，自动扫描）**

```json
{
  "my-server": {
    "command": "node",
    "args": ["./server.js"],
    "env": { "API_KEY": "${MY_API_KEY}" }
  }
}
```

**2. plugin.json `mcpServers` 字段（内联）**

同上格式，写在 plugin.json 内。

**3. MCPB 文件（MCP Bundle，.mcpb/.dxt）**

ZIP 格式独立包，通过路径引用：`"mcpServers": "./servers/my-server.mcpb"`

支持传输类型：`stdio`（默认）、`sse`、`http`、`ws`、`sdk`（内置）。

工具命名规则：`mcp__<serverName>__<toolName>`。

`${CLAUDE_PLUGIN_ROOT}` 可在 command/args 中使用，指向插件缓存目录。

---

## 渐进式披露机制

### Tier 1：skill_listing attachment（自动，每条消息）

每条用户消息发送前，生成 `skill_listing` attachment，格式：

```
- <skill-name>: <description>[ - <when_to_use>]
```

受 Token 预算限制（`SKILL_BUDGET_CONTEXT_PERCENT = 0.02`，约 16K 字符）。超预算时截断非内置 Skill 的 description。

### Tier 2：Skill 工具调用（按需加载完整内容）

Claude 调用 `Skill` 工具 → 加载 SKILL.md 完整内容 → 解析 frontmatter → 展开变量 → 执行。

### Tier 3：辅助文档（Agent 按需 Read）

SKILL.md 正文指示 Claude 用 Read 工具读取 `${CLAUDE_SKILL_DIR}/reference.md` 等本地文件。

### SessionStart Hook（旁路注入）

`hooks/hooks.json` 可配置 `SessionStart` 钩子，将内容直接注入 `additionalContext`，绕过 Skill 工具调用。superpowers 用此方式在会话开始时注入完整行为规范。

---

## 安装与缓存

### 缓存结构

```
~/.claude/plugins/
├── cache/<marketplace-id>/<plugin-name>/<version>/
├── installed_plugins.json    # V2 安装记录
└── blocklist.json            # 封锁名单（Anthropic 远程拉取）
```

### installed_plugins.json

```json
{
  "version": 2,
  "plugins": {
    "superpowers@claude-plugins-official": [{
      "scope": "user",
      "installPath": "~/.claude/plugins/cache/.../4.3.0",
      "version": "4.3.0",
      "installedAt": "..."
    }]
  }
}
```

### 启用控制

各级 `settings.json` 的 `enabledPlugins` 字段：

```json
{ "enabledPlugins": { "superpowers@claude-plugins-official": true } }
```

### Marketplace 数据源

| source 类型 | 描述 |
|---|---|
| `github` | GitHub 仓库（`owner/repo`），支持 `ref`/`path`/`sparsePaths` |
| `git` | 任意 Git URL |
| `npm` | NPM 包 |
| `url` | 直接 URL |
| `file` / `directory` | 本地路径 |

---

## Skills + MCP 的关系

两者是独立组件，Plugin 只是打包容器：

| 模式 | 示例 |
|------|------|
| 只有 Skills | superpowers（纯提示词指令库） |
| 只有 MCP | context7、playwright（只扩展工具） |
| 两者都有 | Skills 的 `allowed-tools` 声明 `mcp__<server>__*` 绑定工具能力与指导文档 |

---

## 对 CodeClaw 的设计启示

1. **CodeClaw 的 Telegram Skill 可包装为 Plugin**：`.mcp.json` 定义 MCP 工具 + `skills/telegram/SKILL.md` 定义操作手册
2. **Runtime 级工具（如 show_progress）不属于 channel Skill**：应放在 `SDK_SYSTEM_APPEND`（等价于 SessionStart Hook 注入）
3. **description 字段决定触发率**：用 "Use when [条件]" 格式写，精准描述触发场景
4. **`${CLAUDE_SKILL_DIR}` 模式可复用**：让 SKILL.md 引用同目录的参考文档，实现 Tier 3 按需深入
5. **个人 Skill 优先于 Plugin Skill**：CodeClaw 的 `~/.claude/skills/telegram/` 路径符合个人 Skill 约定
