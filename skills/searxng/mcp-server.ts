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

  if (data.suggestions?.length > 0) {
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
