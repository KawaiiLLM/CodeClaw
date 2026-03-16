---
name: crawl4ai
description: "Web crawl: fetch a web page and save its content as markdown. Use when you need to read the full content of a URL."
---

# Web Crawl (Crawl4AI)

Crawl web pages via a self-hosted Crawl4AI instance (Playwright + Chromium). Content is saved as markdown files to a local cache directory. Supports JavaScript-rendered pages.

## MCP Tool

One tool provided by the `crawl4ai` MCP server (prefix: `mcp__crawl4ai__`).

### `web_crawl`

Crawl a URL and save the page content as a markdown file. Returns file path and metadata (char count, line count). **Does not return the page content directly** — use the Read tool to read the saved file.

**Required:** `url` — the page URL to crawl.

**Optional:**
- `filter` — `fit` (default, removes navigation/sidebar/footer noise) or `raw` (full page content)

## Cache

Crawled files are stored in `~/crawl-cache/` as `{domain}-{hash}.md`. Max 50 files; oldest are automatically evicted.

Each file starts with HTML comments containing source URL and crawl timestamp.

## Usage Pattern

1. Crawl the page:
```
mcp__crawl4ai__web_crawl(url="https://example.com/docs/api")
```
Returns: file path, char count, line count.

2. Read the saved file (or part of it):
```
Read(file_path="/home/codeclaw/crawl-cache/example.com-a1b2c3d4.md")
```

## When to Use

- Reading documentation, wiki pages, articles, blog posts
- Fetching API references or changelogs
- Any page that needs JavaScript rendering (SPAs, dynamic content)
- When you need the **full content** of a page, not just search snippets

## When NOT to Use

- For search queries — use `mcp__searxng__web_search` instead
- For simple API calls — use `fetch` in Bash instead
