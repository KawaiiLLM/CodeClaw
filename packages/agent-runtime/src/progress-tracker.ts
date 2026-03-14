import path from "node:path";
import type { KernelClient } from "./kernel-client.js";
import { logger } from "./logger.js";

/** Output tools — don't show in progress (message gets deleted on send anyway) */
const HIDDEN_TOOLS = new Set([
  "mcp__codeclaw__send_message",
  "mcp__codeclaw__skip_reply",
  "mcp__codeclaw__send_sticker",
  "mcp__codeclaw__send_poll",
]);

const MAX_VISIBLE = 12;
const MIN_EDIT_INTERVAL_MS = 5000;
/** Don't show progress until tools have been running for this long */
const GRACE_PERIOD_MS = 30_000;

interface ToolEntry {
  id: string;
  name: string;
  label: string;
  status: "active" | "done";
  elapsed: number;
}

interface SubAgentEntry {
  taskId: string;
  description: string;
  lastToolName?: string;
  toolUses: number;
  status: "active" | "done";
}

/**
 * Tracks SDK tool execution and renders a live progress message in Telegram.
 *
 * Mirrors Claude Code's terminal UI: shows tool call chain with status icons,
 * elapsed time, sub-agent nesting, and a blinking cursor on the active entry.
 *
 * The progress message uses `progress: true` (skips JSONL) and is deleted
 * when the agent sends its final reply or the turn completes.
 */
export class ProgressTracker {
  private messageId: string | null = null;
  private entries: ToolEntry[] = [];
  private subAgents = new Map<string, SubAgentEntry>();
  private blinkState = false;
  private lastEditTime = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEdit = false;

  private channel = "";
  private conversationId = "";
  private replyToId?: string;
  private targetLocked = false;

  /** Timestamp of first tool start — used for grace period */
  private firstToolTime: number | null = null;

  /** Consecutive edit failures — backs off to avoid 429 cascade */
  private consecutiveFailures = 0;
  private static readonly MAX_BACKOFF_MS = 30_000;

  /** Called when the first progress message is created (e.g. to stop typing) */
  private progressStartedCallback: (() => void) | null = null;

  constructor(private kernelClient: KernelClient) {}

  /** Register a callback for when the first progress message is created. */
  onProgressStarted(fn: () => void): void {
    this.progressStartedCallback = fn;
  }

  /**
   * Set the target conversation for the progress message.
   * Ignored once a progress message has been created (target locked until cleanup).
   */
  setTarget(channel: string, conversationId: string, replyToId?: string): void {
    if (this.targetLocked) return;
    this.channel = channel;
    this.conversationId = conversationId;
    this.replyToId = replyToId;
  }

  /** content_block_start with tool_use / mcp_tool_use */
  onToolStarted(id: string, name: string): void {
    if (HIDDEN_TOOLS.has(name)) return;
    if (this.entries.some((e) => e.id === id)) return;
    if (!this.firstToolTime) this.firstToolTime = Date.now();
    this.entries.push({
      id,
      name,
      label: formatToolLabel(name, null),
      status: "active",
      elapsed: 0,
    });
    this.scheduleEdit();
  }

  /** AssistantMessage — resolve tool input for richer labels */
  onToolInputResolved(id: string, input: unknown): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    const newLabel = formatToolLabel(entry.name, input);
    if (newLabel !== entry.label) {
      entry.label = newLabel;
      this.scheduleEdit();
    }
  }

  /** message_start from a new response — previous batch of tools completed */
  onNewResponse(): void {
    let changed = false;
    for (const e of this.entries) {
      if (e.status === "active") {
        e.status = "done";
        changed = true;
      }
    }
    if (changed) this.scheduleEdit();
  }

  /** tool_progress heartbeat */
  onToolProgress(toolUseId: string, elapsed: number): void {
    const entry = this.entries.find((e) => e.id === toolUseId);
    if (entry) {
      entry.elapsed = elapsed;
      this.scheduleEdit();
    }
  }

  /** system.task_started */
  onSubAgentStarted(taskId: string, description: string): void {
    this.subAgents.set(taskId, {
      taskId,
      description,
      toolUses: 0,
      status: "active",
    });
    this.scheduleEdit();
  }

  /** system.task_progress */
  onSubAgentProgress(
    taskId: string,
    lastTool?: string,
    toolUses?: number,
  ): void {
    const sub = this.subAgents.get(taskId);
    if (!sub) return;
    if (lastTool) sub.lastToolName = lastTool;
    if (toolUses != null) sub.toolUses = toolUses;
    this.scheduleEdit();
  }

  /** system.task_notification — sub-agent completed */
  onSubAgentCompleted(taskId: string): void {
    const sub = this.subAgents.get(taskId);
    if (sub) sub.status = "done";
    this.scheduleEdit();
  }

  /** Delete progress message and reset all state */
  async cleanup(): Promise<void> {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    if (this.messageId) {
      try {
        await this.kernelClient.sendOutbound({
          channel: this.channel,
          conversation: this.conversationId,
          skillEndpoint: "/delete",
          payload: {
            conversation: this.conversationId,
            messageId: Number(this.messageId),
          },
        });
      } catch (err) {
        logger.debug(
          { err },
          "ProgressTracker: failed to delete progress message",
        );
      }
      this.messageId = null;
    }

    this.entries = [];
    this.subAgents.clear();
    this.blinkState = false;
    this.lastEditTime = 0;
    this.pendingEdit = false;
    this.targetLocked = false;
    this.firstToolTime = null;
    this.consecutiveFailures = 0;
  }

  // --- Rendering ---

  private render(): string {
    const lines: string[] = [];
    const doneCount = this.entries.filter((e) => e.status === "done").length;
    const activeCount = this.entries.filter((e) => e.status === "active").length;
    const maxDone = Math.max(MAX_VISIBLE - activeCount, 3);
    const hiddenCount = Math.max(0, doneCount - maxDone);

    if (hiddenCount > 0) lines.push(`... ${hiddenCount} steps`);

    let skipped = 0;
    let lastActiveLineIdx = -1;

    for (const e of this.entries) {
      if (e.status === "done" && skipped < hiddenCount) {
        skipped++;
        continue;
      }

      const icon = e.status === "active" ? "\u23f3" : "\u2705";
      const time = e.elapsed > 0 ? ` (${Math.round(e.elapsed)}s)` : "";
      lines.push(`${icon} ${e.label}${time}`);
      if (e.status === "active") lastActiveLineIdx = lines.length - 1;

      // Sub-agents nested under Agent tool
      if (e.name === "Agent") {
        this.renderSubAgents(lines, "  ");
        if (
          [...this.subAgents.values()].some((s) => s.status === "active")
        ) {
          lastActiveLineIdx = lines.length - 1;
        }
      }
    }

    // Orphan sub-agents (no Agent entry in current entries)
    if (
      this.subAgents.size > 0 &&
      !this.entries.some((e) => e.name === "Agent")
    ) {
      this.renderSubAgents(lines, "");
      if ([...this.subAgents.values()].some((s) => s.status === "active")) {
        lastActiveLineIdx = lines.length - 1;
      }
    }

    // Blinking cursor on last active line
    if (lastActiveLineIdx >= 0 && this.blinkState) {
      lines[lastActiveLineIdx] += "\u258d";
    }

    return lines.join("\n") || "\u23f3 ...";
  }

  private renderSubAgents(lines: string[], indent: string): void {
    for (const [, sub] of this.subAgents) {
      const icon = sub.status === "active" ? "\u23f3" : "\u2705";
      let detail = "";
      if (sub.lastToolName) {
        detail = ` \u2014 ${sub.lastToolName}`;
        if (sub.toolUses > 1) detail += ` (${sub.toolUses})`;
      }
      lines.push(`${indent}${icon} ${sub.description}${detail}`);
    }
  }

  // --- Edit throttling ---

  private scheduleEdit(): void {
    this.pendingEdit = true;
    const now = Date.now();

    // Grace period: don't show progress until tools have been running for 30s
    if (!this.messageId && this.firstToolTime) {
      const graceRemaining = GRACE_PERIOD_MS - (now - this.firstToolTime);
      if (graceRemaining > 0) {
        if (!this.editTimer) {
          this.editTimer = setTimeout(() => {
            this.editTimer = null;
            if (this.pendingEdit) this.doEdit().catch(() => {});
          }, graceRemaining);
        }
        return;
      }
    }

    // Exponential backoff on consecutive failures (e.g. Telegram 429)
    const backoffMs = this.consecutiveFailures > 0
      ? Math.min(MIN_EDIT_INTERVAL_MS * 2 ** this.consecutiveFailures, ProgressTracker.MAX_BACKOFF_MS)
      : MIN_EDIT_INTERVAL_MS;

    const elapsed = now - this.lastEditTime;

    if (elapsed >= backoffMs) {
      this.doEdit().catch(() => {});
    } else if (!this.editTimer) {
      this.editTimer = setTimeout(() => {
        this.editTimer = null;
        if (this.pendingEdit) this.doEdit().catch(() => {});
      }, backoffMs - elapsed);
    }
  }

  private async doEdit(): Promise<void> {
    this.pendingEdit = false;
    this.blinkState = !this.blinkState;

    if (!this.channel || !this.conversationId) return;
    this.lastEditTime = Date.now();

    const text = this.render();

    try {
      if (this.messageId) {
        // Edit existing progress message
        await this.kernelClient.sendMessage({
          channel: this.channel,
          conversation: this.conversationId,
          content: { type: "text", text },
          editMessageId: this.messageId,
        });
      } else {
        // Send new progress message
        this.targetLocked = true;
        const res = await this.kernelClient.sendMessage({
          channel: this.channel,
          conversation: this.conversationId,
          content: { type: "text", text },
          replyTo: this.replyToId,
          progress: true,
        });
        this.messageId = res.messageId ? String(res.messageId) : null;
        // Notify agent-loop to stop typing (progress message replaces typing indicator)
        if (this.messageId) {
          this.progressStartedCallback?.();
        }
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      logger.debug(
        { err, failures: this.consecutiveFailures },
        "ProgressTracker: failed to send/edit progress",
      );
    }
  }
}

// --- Tool label formatting ---

function formatToolLabel(name: string, input: unknown): string {
  const inp = input as Record<string, any> | null;
  switch (name) {
    case "Read":
      return inp?.file_path ? `Read ${path.basename(inp.file_path)}` : "Read";
    case "Write":
      return inp?.file_path ? `Write ${path.basename(inp.file_path)}` : "Write";
    case "Edit":
      return inp?.file_path ? `Edit ${path.basename(inp.file_path)}` : "Edit";
    case "Bash": {
      if (!inp?.command) return "Bash";
      const cmd = String(inp.command);
      return `$ ${cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd}`;
    }
    case "Glob":
      return inp?.pattern ? `Glob ${inp.pattern}` : "Glob";
    case "Grep":
      return inp?.pattern ? `Grep "${inp.pattern}"` : "Grep";
    case "Agent":
      return inp?.description
        ? `Agent: ${truncate(inp.description, 40)}`
        : "Agent";
    case "WebSearch":
      return inp?.query ? `Search: ${truncate(inp.query, 30)}` : "WebSearch";
    case "WebFetch": {
      if (inp?.url) {
        try {
          return `Fetch: ${new URL(String(inp.url)).hostname}`;
        } catch {
          /* invalid URL */
        }
      }
      return "WebFetch";
    }
    case "mcp__codeclaw__react_message":
      return inp?.emoji ? `React ${inp.emoji}` : "React";
    case "mcp__codeclaw__edit_message":
      return "Edit message";
    case "mcp__codeclaw__delete_message":
      return "Delete message";
    case "mcp__codeclaw__get_sticker_set":
      return inp?.name ? `Stickers: ${inp.name}` : "Stickers";
    case "mcp__codeclaw__get_message":
      return "Get message";
    default: {
      if (name.startsWith("mcp__codeclaw__"))
        return name.slice("mcp__codeclaw__".length);
      return name;
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}
