import type { AgentHealthReport } from "@codeclaw/types";
import { ContainerManager } from "./container-manager.js";
import { logger } from "./logger.js";

interface AgentState {
  agentId: string;
  lastHealth: AgentHealthReport | null;
  lastHealthAt: number;
  consecutiveFailures: number;
  monitorInterval: ReturnType<typeof setInterval> | null;
  crashCallbacks: Array<() => void>;
}

const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_TIMEOUT_MS = 30_000; // Consider agent unhealthy after 30s without health report

export class AgentSupervisor {
  private agents = new Map<string, AgentState>();

  constructor(private containerManager: ContainerManager) {}

  /** Start health monitoring for an agent. */
  startMonitoring(agentId: string, intervalMs: number = 10_000): void {
    if (this.agents.has(agentId)) {
      this.stopMonitoring(agentId);
    }

    const state: AgentState = {
      agentId,
      lastHealth: null,
      lastHealthAt: Date.now(),
      consecutiveFailures: 0,
      monitorInterval: null,
      crashCallbacks: [],
    };

    state.monitorInterval = setInterval(() => {
      this.checkHealth(agentId).catch((err) => {
        logger.error({ agentId, err }, "Health check error");
      });
    }, intervalMs);

    this.agents.set(agentId, state);
    logger.info({ agentId, intervalMs }, "Started monitoring agent");
  }

  /** Stop health monitoring for an agent. */
  stopMonitoring(agentId: string): void {
    const state = this.agents.get(agentId);
    if (state?.monitorInterval) {
      clearInterval(state.monitorInterval);
      state.monitorInterval = null;
    }
    this.agents.delete(agentId);
    logger.info({ agentId }, "Stopped monitoring agent");
  }

  /** Register a callback for when an agent crashes. */
  onCrash(agentId: string, callback: () => void): void {
    const state = this.agents.get(agentId);
    if (state) {
      state.crashCallbacks.push(callback);
    }
  }

  /** Called by the HTTP server when an agent reports health. */
  reportHealth(report: AgentHealthReport): void {
    let state = this.agents.get(report.agentId);
    if (!state) {
      // Auto-register agents that report health (e.g. manually deployed containers)
      state = {
        agentId: report.agentId,
        lastHealth: null,
        lastHealthAt: Date.now(),
        consecutiveFailures: 0,
        monitorInterval: null,
        crashCallbacks: [],
      };
      this.agents.set(report.agentId, state);
      logger.info({ agentId: report.agentId }, "Auto-registered agent from health report");
    }

    state.lastHealth = report;
    state.lastHealthAt = Date.now();
    state.consecutiveFailures = 0;

    logger.debug({ agentId: report.agentId, status: report.status }, "Agent health report received");
  }

  /** Get the last known health state of an agent. */
  getHealth(agentId: string): { status: string; lastReportAt: number; conversation?: string } | null {
    const state = this.agents.get(agentId);
    if (!state) return null;
    return {
      status: state.lastHealth?.status ?? "unknown",
      lastReportAt: state.lastHealthAt,
      conversation: state.lastHealth?.conversation,
    };
  }

  /** Get health states for all monitored agents. */
  getAllHealth(): Record<string, { status: string; lastReportAt: number; conversation?: string }> {
    const result: Record<string, { status: string; lastReportAt: number; conversation?: string }> = {};
    for (const [agentId, state] of this.agents) {
      result[agentId] = {
        status: state.lastHealth?.status ?? "unknown",
        lastReportAt: state.lastHealthAt,
        conversation: state.lastHealth?.conversation,
      };
    }
    return result;
  }

  /** Get the last session ID reported by an agent (for session resume). */
  getLastSessionId(agentId: string): string | undefined {
    return this.agents.get(agentId)?.lastHealth?.sessionId;
  }

  /** Get the last assistant message ID (for resumeSessionAt). */
  getLastAssistantMessageId(agentId: string): string | undefined {
    return this.agents.get(agentId)?.lastHealth?.lastAssistantMessageId;
  }

  /** Stop all monitoring. */
  shutdown(): void {
    for (const agentId of this.agents.keys()) {
      this.stopMonitoring(agentId);
    }
  }

  private async checkHealth(agentId: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;

    const isRunning = await this.containerManager.isRunning(agentId);

    if (!isRunning) {
      state.consecutiveFailures++;
      logger.warn({ agentId, failures: state.consecutiveFailures }, "Agent container not running");

      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.handleCrash(agentId, state);
      }
      return;
    }

    // Check if health reports have timed out
    const timeSinceLastHealth = Date.now() - state.lastHealthAt;
    if (state.lastHealth && timeSinceLastHealth > HEALTH_TIMEOUT_MS) {
      state.consecutiveFailures++;
      logger.warn({ agentId, timeSinceLastHealth, failures: state.consecutiveFailures }, "Agent health report timed out");

      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.handleCrash(agentId, state);
      }
    }
  }

  private async handleCrash(agentId: string, state: AgentState): Promise<void> {
    logger.error({ agentId }, "Agent crash detected, attempting restart");

    // Notify callbacks
    for (const cb of state.crashCallbacks) {
      try {
        cb();
      } catch (err) {
        logger.error({ agentId, err }, "Crash callback error");
      }
    }

    // Restart container
    try {
      await this.containerManager.restartAgent(agentId);
      state.consecutiveFailures = 0;
      state.lastHealthAt = Date.now();
      logger.info({ agentId }, "Agent container restarted after crash");
    } catch (err) {
      logger.error({ agentId, err }, "Failed to restart agent container");
    }
  }
}
