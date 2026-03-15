import type { InboundMessage } from "@codeclaw/types";

interface QueueEntry {
  message: InboundMessage;
  priority: number;
  enqueuedAt: number;
}

const DEFAULT_PRIORITY = 10;

export class MessageQueue {
  private queue: QueueEntry[] = [];
  private seenIds = new Map<string, number>(); // dedupeKey -> timestamp

  /**
   * Enqueue a message. Deduplicates by message ID.
   * Lower priority number = higher priority (processed first).
   */
  enqueue(msg: InboundMessage, priority: number = DEFAULT_PRIORITY): boolean {
    const dedupeKey = `${msg.channel}:${msg.id}`;
    if (this.seenIds.has(dedupeKey)) {
      return false;
    }
    this.seenIds.set(dedupeKey, Date.now());

    const entry: QueueEntry = {
      message: msg,
      priority,
      enqueuedAt: Date.now(),
    };

    // Insert in sorted position (stable: same priority → FIFO)
    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > priority) {
        insertIdx = i;
        break;
      }
    }
    this.queue.splice(insertIdx, 0, entry);
    return true;
  }

  /** Dequeue the highest-priority message, optionally filtered by agentId. */
  dequeue(agentId?: string): InboundMessage | null {
    if (!agentId) {
      const entry = this.queue.shift();
      return entry?.message ?? null;
    }
    // Find first entry matching agentId
    const idx = this.queue.findIndex((e) => e.message.agentId === agentId);
    if (idx === -1) return null;
    const [entry] = this.queue.splice(idx, 1);
    return entry.message;
  }

  /** Peek at the next message without removing it. */
  peek(): InboundMessage | null {
    return this.queue[0]?.message ?? null;
  }

  /** Total pending messages, optionally filtered by agentId. */
  pendingCount(agentId?: string): number {
    if (!agentId) return this.queue.length;
    return this.queue.filter((e) => e.message.agentId === agentId).length;
  }

  /** Pending messages grouped by channel. */
  pendingByChannel(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.queue) {
      const ch = entry.message.channel;
      result[ch] = (result[ch] ?? 0) + 1;
    }
    return result;
  }

  /** Pending messages grouped by agentId. */
  pendingByAgent(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.queue) {
      const id = entry.message.agentId ?? "_untagged";
      result[id] = (result[id] ?? 0) + 1;
    }
    return result;
  }

  /** List of channels with pending messages. */
  channels(): string[] {
    return Object.keys(this.pendingByChannel());
  }

  /** Clear dedup entries older than maxAge. */
  pruneDedup(maxAge: number = 3600_000): void {
    const cutoff = Date.now() - maxAge;
    for (const [key, timestamp] of this.seenIds) {
      if (timestamp < cutoff) {
        this.seenIds.delete(key);
      }
    }
  }
}
