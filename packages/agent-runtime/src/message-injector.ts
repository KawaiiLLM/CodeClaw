import type { InboundMessage } from "@codeclaw/types";
import { KernelClient } from "./kernel-client.js";
import { logger } from "./logger.js";

/**
 * Polls the kernel for inbound messages and provides them to the agent loop
 * via an async wait mechanism.
 */
export class MessageInjector {
  private queue: InboundMessage[] = [];
  private resolveWaiter: ((msg: InboundMessage) => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private kernelClient: KernelClient,
    private pollIntervalMs: number = 500,
  ) {}

  /** Start polling the kernel for new messages. */
  start(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(async () => {
      try {
        await this.poll();
      } catch (err) {
        logger.error({ err }, "Message poll error");
      }
    }, this.pollIntervalMs);

    // Also poll immediately
    this.poll().catch(() => {});

    logger.info({ intervalMs: this.pollIntervalMs }, "Message injector started");
  }

  /** Stop polling. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("Message injector stopped");
  }

  /** Push a message directly (used for local injection, e.g., from MCP). */
  push(msg: InboundMessage): void {
    if (this.resolveWaiter) {
      // Someone is waiting, deliver immediately
      const resolve = this.resolveWaiter;
      this.resolveWaiter = null;
      resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /** Wait for the next message (used by the agent loop's AsyncGenerator). */
  async waitForMessage(): Promise<InboundMessage> {
    // Return from local queue first
    const queued = this.queue.shift();
    if (queued) return queued;

    // Wait for next push/poll delivery
    return new Promise<InboundMessage>((resolve) => {
      this.resolveWaiter = resolve;
    });
  }

  /** Check if there are pending messages (for mid-task injection). */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** Peek at the next pending message without consuming it. */
  peekPending(): InboundMessage | null {
    return this.queue[0] ?? null;
  }

  /** Number of locally queued messages. */
  pendingCount(): number {
    return this.queue.length;
  }

  private async poll(): Promise<void> {
    // Drain all available messages from kernel in one poll cycle
    while (true) {
      const msg = await this.kernelClient.getNextMessage();
      if (!msg) break;
      logger.debug({ channel: msg.channel, sender: msg.sender.name }, "Polled message from kernel");
      this.push(msg);
    }
  }
}
