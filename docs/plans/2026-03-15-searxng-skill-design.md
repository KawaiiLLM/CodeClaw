# SearXNG Search Skill 设计

> 日期: 2026-03-15
> 状态: 已批准

## 概述

为 CodeClaw Agent 添加 SearXNG 搜索 Skill，使 Agent 具备网络搜索能力。SearXNG 作为独立 Docker 容器部署在 Host 上，Skill 以纯 MCP stdio server 形式集成，不需要 HTTP 服务进程，不经 Kernel。

## 架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| SearXNG 部署 | Host 独立 Docker 容器 (:8080) | 与 Agent 容器解耦，独立运维 |
| Skill 类型 | `tool`（非 `channel`） | 不处理 inbound/outbound 消息，纯工具 |
| MCP 工具数量 | 1 个 `web_search` | 工具总量 ≤10 约束；参数控制过滤即可 |
| 配置方式 | 环境变量 `SEARXNG_URL` | 最简，与现有 Skill 模式一致 |
| 语言 | TypeScript | 项目生态一致，无需 Python |
| 额外依赖 | 无（fetch 直调 SearXNG API） | SearXNG JSON API 极简，不值得引入外部库 |

## 文件结构

```
skills/searxng/
├── manifest.json        # type: "tool", 只有 mcpEntrypoint
├── mcp-server.ts        # stdio MCP server (~80 行)
├── SKILL.md             # Agent 操作手册
├── package.json         # @modelcontextprotocol/sdk + zod
└── tsconfig.json
```

## manifest.json

```json
{
  "skillId": "searxng",
  "type": "tool",
  "mcpEntrypoint": "/codeclaw/skills/searxng/mcp-server.ts",
  "capabilities": ["web_search"]
}
```

没有 `entrypoint` 字段。Runtime index.ts 的两个扫描循环互相独立：
- HTTP 服务循环：检查 `entrypoint`，没有则安全跳过
- MCP 注册循环：检查 `mcpEntrypoint`，正常注册 stdio server

不需要修改 Runtime 代码。

## MCP 工具：`web_search`

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索关键词 |
| `categories` | string | 否 | 逗号分隔，如 `general,news` |
| `engines` | string | 否 | 指定引擎，如 `google,bing` |
| `language` | string | 否 | 语言代码，如 `zh-CN` |
| `time_range` | enum | 否 | `day` / `month` / `year` |
| `max_results` | number | 否 | 返回条数上限（默认 10，应用层截取） |

### 返回格式

格式化为 Markdown 文本，减少 Agent 上下文消耗：

```
Found 5 results for "query":

1. [Title](url)
   snippet text here...

2. [Title](url)
   snippet text here...
```

### 错误处理

- SearXNG 不可达 → 返回 `isError: true`，文本说明连接失败
- 搜索无结果 → 返回 `No results found for "query"`
- 部分引擎超时 → 正常返回可用结果（SearXNG 自动处理）

## 数据流

```
Agent 调用 mcp__searxng__web_search(query, ...)
  → stdio MCP server 进程
    → fetch GET ${SEARXNG_URL}/search?q=...&format=json
      → SearXNG 容器 (:8080, Host)
        → 并发查询 Google/Bing/DDG 等上游引擎
    ← JSON 聚合结果
  ← 格式化 Markdown 返回 Agent
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SEARXNG_URL` | `http://host.docker.internal:8080` | SearXNG 实例地址 |

## SKILL.md

```yaml
---
name: searxng
description: "Web search: find information, articles, documentation online. Use when you need to search the internet."
---
```

Body 包含 MCP 工具用法、参数说明、搜索技巧（`engines` 指定、`time_range` 过滤等）。

## SearXNG 部署要点

SearXNG 容器 `settings.yml` 必须配置：

```yaml
search:
  formats: [html, json]    # 默认不开 json，必须显式添加
server:
  limiter: false            # 内部使用，关闭限速
outgoing:
  proxies:
    all://:
      - socks5://host.docker.internal:7890  # 代理访问 Google 等被封引擎
```

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a SearXNG search MCP tool to CodeClaw Agent

**Architecture:** Pure stdio MCP server, no HTTP service, no Kernel interaction. Single `web_search` tool that fetches SearXNG JSON API and returns formatted Markdown.

**Tech Stack:** TypeScript ESM, @modelcontextprotocol/sdk, zod

---

### Task 1: Create package scaffolding

**Files:**
- Create: `skills/searxng/package.json`
- Create: `skills/searxng/tsconfig.json`
- Create: `skills/searxng/manifest.json`

**Step 1: Create package.json**

```json
{
  "name": "@codeclaw/skill-searxng",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.8.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["."]
}
```

**Step 3: Create manifest.json**

```json
{
  "skillId": "searxng",
  "type": "tool",
  "mcpEntrypoint": "/codeclaw/skills/searxng/mcp-server.ts",
  "capabilities": ["web_search"]
}
```

**Step 4: Install dependencies**

Run: `pnpm install`

**Step 5: Verify typecheck setup**

Run: `pnpm -F @codeclaw/skill-searxng typecheck`
Expected: May warn about no input files (no .ts yet), but should not error on config.

**Step 6: Commit**

```bash
git add skills/searxng/package.json skills/searxng/tsconfig.json skills/searxng/manifest.json pnpm-lock.yaml
git commit -m "feat(searxng): add skill package scaffolding"
```

---

### Task 2: Implement MCP server

**Files:**
- Create: `skills/searxng/mcp-server.ts`

**Step 1: Write the MCP server**

```typescript
// skills/searxng/mcp-server.ts
// Standalone stdio MCP server for web search via SearXNG.
// Launched by Agent Runtime as a subprocess via McpStdioServerConfig.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://host.docker.internal:8080";

interface SearxResult {
  url: string;
  title: string;
  content: string;
  engine: string;
  engines: string[];
  score: number;
}

interface SearxResponse {
  query: string;
  number_of_results: number;
  results: SearxResult[];
  suggestions: string[];
  unresponsive_engines: string[];
}

async function searchSearxng(params: {
  query: string;
  categories?: string;
  engines?: string;
  language?: string;
  time_range?: string;
  max_results?: number;
}): Promise<string> {
  const url = new URL("/search", SEARXNG_URL);
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  if (params.categories) url.searchParams.set("categories", params.categories);
  if (params.engines) url.searchParams.set("engines", params.engines);
  if (params.language) url.searchParams.set("language", params.language);
  if (params.time_range) url.searchParams.set("time_range", params.time_range);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`SearXNG returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as SearxResponse;
  const maxResults = params.max_results ?? 10;
  const results = data.results.slice(0, maxResults);

  if (results.length === 0) {
    return `No results found for "${params.query}"`;
  }

  const lines: string[] = [`Found ${results.length} results for "${params.query}":\n`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. [${r.title}](${r.url})`);
    if (r.content) {
      lines.push(`   ${r.content}\n`);
    }
  }

  if (data.suggestions.length > 0) {
    lines.push(`Suggestions: ${data.suggestions.join(", ")}`);
  }

  return lines.join("\n");
}

// --- MCP Server ---

const server = new McpServer({ name: "searxng", version: "0.1.0" });

server.tool(
  "web_search",
  "Search the web using SearXNG. Returns titles, URLs, and snippets.",
  {
    query: z.string().describe("Search query"),
    categories: z.string().optional().describe("Comma-separated categories: general, news, images, videos, science, files"),
    engines: z.string().optional().describe("Comma-separated engines: google, bing, duckduckgo, brave, baidu, wikipedia, arxiv, github"),
    language: z.string().optional().describe("Language code, e.g. zh-CN, en"),
    time_range: z.enum(["day", "month", "year"]).optional().describe("Filter by time range"),
    max_results: z.number().min(1).max(30).optional().describe("Max results to return (default 10)"),
  },
  async ({ query, categories, engines, language, time_range, max_results }) => {
    try {
      const text = await searchSearxng({ query, categories, engines, language, time_range, max_results });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Search failed: ${msg}` }], isError: true };
    }
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 2: Typecheck**

Run: `pnpm -F @codeclaw/skill-searxng typecheck`
Expected: PASS (0 errors)

**Step 3: Verify MCP server starts and exits cleanly**

Run: `echo '{}' | timeout 3 npx tsx skills/searxng/mcp-server.ts 2>/dev/null || true`
Expected: Process starts without crash (will timeout since it waits for stdio input, that's fine)

**Step 4: Commit**

```bash
git add skills/searxng/mcp-server.ts
git commit -m "feat(searxng): implement web_search MCP server"
```

---

### Task 3: Write SKILL.md

**Files:**
- Create: `skills/searxng/SKILL.md`

**Step 1: Write SKILL.md**

```markdown
---
name: searxng
description: "Web search: find information, articles, documentation online. Use when you need to search the internet."
---

# Web Search (SearXNG)

Search the internet via a self-hosted SearXNG instance. Results come from multiple engines (Google, Bing, DuckDuckGo, etc.) aggregated and deduplicated.

## MCP Tool

One tool provided by the `searxng` MCP server (prefix: `mcp__searxng__`).

### `web_search`

Search the web. Returns a formatted list of titles, URLs, and snippets.

**Required:** `query` — your search terms.

**Optional filters:**
- `categories` — comma-separated: `general`, `news`, `images`, `videos`, `science`, `files`
- `engines` — comma-separated: `google`, `bing`, `duckduckgo`, `brave`, `baidu`, `wikipedia`, `arxiv`, `github`
- `language` — e.g. `zh-CN`, `en`, `ja`
- `time_range` — `day`, `month`, or `year`
- `max_results` — 1-30 (default 10)

**Examples:**

General search:
\`\`\`
mcp__searxng__web_search(query="TypeScript ESM module resolution")
\`\`\`

Chinese news from last day:
\`\`\`
mcp__searxng__web_search(query="AI Agent 框架", categories="news", language="zh-CN", time_range="day")
\`\`\`

Search only GitHub:
\`\`\`
mcp__searxng__web_search(query="MCP server template", engines="github")
\`\`\`

Academic papers:
\`\`\`
mcp__searxng__web_search(query="LLM tool use", categories="science")
\`\`\`
```

**Step 2: Commit**

```bash
git add skills/searxng/SKILL.md
git commit -m "docs(searxng): add SKILL.md agent manual"
```

---

### Task 4: Verify runtime integration (no runtime code changes needed)

**Step 1: Verify manifest is picked up by MCP registration loop**

Read `packages/agent-runtime/src/index.ts:100-129` — confirm the MCP loop checks `manifest.mcpEntrypoint` independently of `entrypoint`. A manifest with only `mcpEntrypoint` (no `entrypoint`) should register the MCP server without starting an HTTP service process.

The HTTP service loop (lines 39-98) requires `entrypoint` — it will skip this manifest with a warn log. This is expected behavior for a `tool` type skill.

**Step 2: Typecheck entire project**

Run: `pnpm typecheck`
Expected: PASS across all packages

**Step 3: Commit (if any fixes needed)**

---

### Task 5: Update design.md

**Files:**
- Modify: `docs/design.md` — add SearXNG Skill to 仓库结构 and 模块职责

**Step 1: Add SearXNG to the 仓库结构 tree**

Add under `skills/`:
```
│   └── searxng/
│       ├── mcp-server.ts           # stdio MCP server (1 工具: web_search)
│       ├── manifest.json           # Skill 清单 (tool 类型, 只有 mcpEntrypoint)
│       ├── SKILL.md                # Agent 可读操作手册
│       └── package.json            # @modelcontextprotocol/sdk + zod
```

**Step 2: Add SearXNG Skill section to 模块职责**

```markdown
### SearXNG Skill (skills/searxng/)

SearXNG Skill 是一个纯工具型 Skill，提供网络搜索能力。不同于通道 Skill，它没有 HTTP 服务进程，不向 Kernel 注册路由。

- **mcp-server.ts**: stdio MCP server，提供 `web_search` 工具。直接 fetch SearXNG JSON API (`/search?format=json`)，将结果格式化为 Markdown 返回 Agent。SearXNG 实例作为独立 Docker 容器部署在 Host 上。
```

**Step 3: Add to 技术决策记录**

```markdown
| SearXNG 搜索 | 自托管元搜索 + stdio MCP | 零成本、多引擎聚合、数据主权、纯工具型无需 Kernel 路由 |
```

**Step 4: Commit**

```bash
git add docs/design.md
git commit -m "docs: add SearXNG skill to design.md"
```
