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

## Examples

General search:
```
mcp__searxng__web_search(query="TypeScript ESM module resolution")
```

Chinese news from last day:
```
mcp__searxng__web_search(query="AI Agent 框架", categories="news", language="zh-CN", time_range="day")
```

Search only GitHub:
```
mcp__searxng__web_search(query="MCP server template", engines="github")
```

Academic papers:
```
mcp__searxng__web_search(query="LLM tool use", categories="science")
```
