// skills/crawl4ai/mcp-server.ts
// Standalone stdio MCP server for web crawling via Crawl4AI.
// Saves crawled content to ~/crawl-cache/ and returns metadata.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const CRAWL4AI_URL = process.env.CRAWL4AI_URL ?? "http://host.docker.internal:11235";
const HOME = process.env.HOME ?? "/home/codeclaw";
const CACHE_DIR = join(HOME, "crawl-cache");
const MAX_CACHE_FILES = 50;

// Ensure cache dir exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function urlToFilename(url: string): string {
  let host: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, "");
    pathname = parsed.pathname + parsed.search;
  } catch {
    host = "unknown";
    pathname = url;
  }
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
  // Sanitize host for filesystem
  const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 40);
  return `${safeHost}-${hash}.md`;
}

function evictOldFiles(): void {
  const files = readdirSync(CACHE_DIR)
    .map((name) => {
      const path = join(CACHE_DIR, name);
      try {
        return { name, path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => a.mtime - b.mtime);

  while (files.length > MAX_CACHE_FILES) {
    const oldest = files.shift()!;
    try { unlinkSync(oldest.path); } catch { /* ignore */ }
  }
}

interface CrawlResult {
  url: string;
  markdown: string;
  success: boolean;
  error?: string;
}

async function crawlPage(url: string, filter: string): Promise<CrawlResult> {
  const res = await fetch(`${CRAWL4AI_URL}/md`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, f: filter }),
  });

  if (!res.ok) {
    throw new Error(`Crawl4AI returned ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as CrawlResult;
}

// --- MCP Server ---

const server = new McpServer({ name: "crawl4ai", version: "0.1.0" });

server.tool(
  "web_crawl",
  "Crawl a web page and save its content as markdown to a local file. Returns file path and metadata. Use the Read tool to read the saved file when you need the content.",
  {
    url: z.string().url().describe("URL to crawl"),
    filter: z.enum(["fit", "raw"]).optional().describe("Content filter: 'fit' (default, removes nav/sidebar noise) or 'raw' (full page)"),
  },
  async ({ url, filter }) => {
    try {
      const result = await crawlPage(url, filter ?? "fit");

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `Crawl failed: ${result.error ?? "unknown error"}` }],
          isError: true,
        };
      }

      const markdown = result.markdown;
      const filename = urlToFilename(url);
      const filepath = join(CACHE_DIR, filename);

      // Prepend source URL as metadata header
      const header = `<!-- source: ${url} -->\n<!-- crawled: ${new Date().toISOString()} -->\n\n`;
      writeFileSync(filepath, header + markdown, "utf-8");

      // Evict old cache files
      evictOldFiles();

      const lines = markdown.split("\n").length;
      const chars = markdown.length;

      return {
        content: [{
          type: "text" as const,
          text: [
            `Crawled successfully.`,
            `  file: ${filepath}`,
            `  url: ${url}`,
            `  chars: ${chars}`,
            `  lines: ${lines}`,
            `  filter: ${filter ?? "fit"}`,
            ``,
            `Use the Read tool to read the file content.`,
          ].join("\n"),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Crawl failed: ${msg}` }], isError: true };
    }
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
