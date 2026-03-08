import type { InboundMessage } from "@codeclaw/types";

interface QueueEntry {
  message: InboundMessage;
  priority: number;
  enqueuedAt: number;
}

const DEFAULT_PRIORITY = 10;

export class MessageQueue {
  private queue: QueueEntry[] = [];
  private seenIds = new Set<string>();

  /**
   * Enqueue a message. Deduplicates by message ID.
   * Lower priority number = higher priority (processed first).
   */
  enqueue(msg: InboundMessage, priority: number = DEFAULT_PRIORITY): boolean {
    const dedupeKey = `${msg.channel}:${msg.id}`;
    if (this.seenIds.has(dedupeKey)) {
      return false;
    }
    this.seenIds.add(dedupeKey);

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

  /** Dequeue the highest-priority message (lowest priority number). */
  dequeue(): InboundMessage | null {
    const entry = this.queue.shift();
    return entry?.message ?? null;
  }

  /** Peek at the next message without removing it. */
  peek(): InboundMessage | null {
    return this.queue[0]?.message ?? null;
  }

  /** Total pending messages. */
  pendingCount(): number {
    return this.queue.length;
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

  /** List of channels with pending messages. */
  channels(): string[] {
    return Object.keys(this.pendingByChannel());
  }

  /** Clear dedup cache for messages older than the given age (ms). */
  pruneDedup(maxAge: number = 3600_000): void {
    // Simple approach: clear entire set periodically
    // For a personal system this is sufficient
    if (this.seenIds.size > 10_000) {
      this.seenIds.clear();
    }
  }
}
