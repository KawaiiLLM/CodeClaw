import { spawn, type ChildProcess } from "node:child_process";
import { KernelClient } from "./kernel-client.js";
import { logger } from "./logger.js";

interface RunningService {
  skillId: string;
  process: ChildProcess;
  command: string;
  args: string[];
  extraEnv: Record<string, string>;
  port?: number;
  onRestart?: () => Promise<void>;
  startedAt: number;
  restartCount: number;
}

const MAX_RESTART_COUNT = 5;
const RESTART_DELAY_MS = 3000;

export class SkillServiceManager {
  private services = new Map<string, RunningService>();

  constructor(private kernelClient: KernelClient) {}

  /** Start a skill service as a subprocess. */
  async start(opts: { skillId: string; command: string; args?: string[]; port?: number; env?: Record<string, string>; onRestart?: () => Promise<void> }): Promise<void> {
    let { skillId, command, args = [] } = opts;

    if (this.services.has(skillId)) {
      throw new Error(`Skill service '${skillId}' is already running`);
    }

    // Defensive: if command contains spaces and no args, split it
    if (command.includes(" ") && args.length === 0) {
      const parts = command.split(/\s+/);
      command = parts[0];
      args = parts.slice(1);
    }

    const extraEnv: Record<string, string> = {
      ...opts.env,
      ...(opts.port ? { SERVICE_PORT: String(opts.port) } : {}),
    };
    const child = this.spawnService(skillId, command, args, extraEnv);

    this.services.set(skillId, {
      skillId,
      process: child,
      command,
      args,
      extraEnv,
      port: opts.port,
      onRestart: opts.onRestart,
      startedAt: Date.now(),
      restartCount: 0,
    });

    logger.info({ skillId, command, args }, "Skill service started");
  }

  /** Stop a running skill service. */
  async stop(skillId: string): Promise<void> {
    const service = this.services.get(skillId);
    if (!service) {
      throw new Error(`Skill service '${skillId}' is not running`);
    }

    service.process.kill("SIGTERM");

    // Force kill after 5s if still alive
    const forceKillTimer = setTimeout(() => {
      if (!service.process.killed) {
        service.process.kill("SIGKILL");
      }
    }, 5000);

    service.process.once("exit", () => {
      clearTimeout(forceKillTimer);
    });

    this.services.delete(skillId);

    // Unregister from kernel
    try {
      await this.kernelClient.unregisterSkillService(skillId);
    } catch (err) {
      logger.warn({ skillId, err }, "Failed to unregister skill service from kernel");
    }

    logger.info({ skillId }, "Skill service stopped");
  }

  /** List all running skill services. */
  list(): Array<{ skillId: string; command: string; startedAt: number; restartCount: number; pid: number | undefined }> {
    return Array.from(this.services.values()).map((s) => ({
      skillId: s.skillId,
      command: `${s.command} ${s.args.join(" ")}`.trim(),
      startedAt: s.startedAt,
      restartCount: s.restartCount,
      pid: s.process.pid,
    }));
  }

  /** Check if a skill service is running. */
  isRunning(skillId: string): boolean {
    return this.services.has(skillId);
  }

  /** Get the localhost endpoint for a running skill service, or null. */
  getEndpoint(skillId: string): string | null {
    const service = this.services.get(skillId);
    if (!service?.port) return null;
    return `http://localhost:${service.port}`;
  }

  /** Stop all services (for shutdown). */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.services.keys());
    for (const id of ids) {
      try {
        await this.stop(id);
      } catch {
        // best effort
      }
    }
  }

  private spawnService(
    skillId: string,
    command: string,
    args: string[],
    extraEnv?: Record<string, string>,
  ): ChildProcess {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SKILL_ID: skillId,
        ...extraEnv,
      },
    });

    child.stdout?.on("data", (data: Buffer) => {
      logger.debug({ skillId }, data.toString().trim());
    });

    child.stderr?.on("data", (data: Buffer) => {
      logger.warn({ skillId, stream: "stderr" }, data.toString().trim());
    });

    child.on("error", (err) => {
      logger.error({ skillId, err: err.message }, "Skill service spawn error");
      this.services.delete(skillId);
    });

    child.on("exit", (code, signal) => {
      logger.warn({ skillId, code, signal }, "Skill service exited");
      this.handleExit(skillId, code, signal);
    });

    return child;
  }

  private handleExit(skillId: string, code: number | null, _signal: string | null): void {
    const service = this.services.get(skillId);
    if (!service) return; // Already stopped intentionally

    if (code === 0) {
      // Clean exit, just remove
      this.services.delete(skillId);
      return;
    }

    // Crash → auto-restart with backoff
    if (service.restartCount >= MAX_RESTART_COUNT) {
      logger.error({ skillId, restartCount: service.restartCount }, "Skill service exceeded max restarts, giving up");
      this.services.delete(skillId);
      return;
    }

    const delay = RESTART_DELAY_MS * (service.restartCount + 1);
    logger.info({ skillId, restartCount: service.restartCount + 1, delayMs: delay }, "Restarting skill service");

    setTimeout(async () => {
      if (!this.services.has(skillId)) return; // Stopped during delay
      const newChild = this.spawnService(skillId, service.command, service.args, service.extraEnv);
      service.process = newChild;
      service.restartCount++;
      service.startedAt = Date.now();
      if (service.onRestart) {
        try {
          await service.onRestart();
        } catch (err) {
          logger.warn({ skillId, err }, "onRestart callback failed");
        }
      }
    }, delay);
  }
}
