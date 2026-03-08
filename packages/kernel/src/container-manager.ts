import Docker from "dockerode";
import { logger } from "./logger.js";

export interface AgentContainerConfig {
  image: string;
  workspaceVolume: string;
  apiKeyEnv: string;
  kernelUrl: string;
  extraEnv?: Record<string, string>;
  networkMode?: string;
}

export type ContainerStatus =
  | { state: "running"; startedAt: string }
  | { state: "stopped"; exitCode: number }
  | { state: "not_found" };

export class ContainerManager {
  private docker: Docker;
  private containers = new Map<string, string>(); // agentId -> containerId

  constructor() {
    this.docker = new Docker();
  }

  /** Create and register an agent container (does not start it). */
  async createAgent(agentId: string, config: AgentContainerConfig): Promise<void> {
    const containerName = `codeclaw-agent-${agentId}`;

    // Remove existing container with same name if stopped
    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      if (!info.State.Running) {
        await existing.remove();
        logger.info({ agentId, containerName }, "Removed stale container");
      } else {
        // Already running, just track it
        this.containers.set(agentId, info.Id);
        logger.info({ agentId }, "Container already running, tracking it");
        return;
      }
    } catch {
      // Container doesn't exist, proceed to create
    }

    const env = [
      `ANTHROPIC_API_KEY=${process.env[config.apiKeyEnv] ?? process.env.ANTHROPIC_API_KEY ?? ""}`,
      `KERNEL_URL=${config.kernelUrl}`,
      `AGENT_ID=${agentId}`,
      ...Object.entries(config.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
    ];

    const container = await this.docker.createContainer({
      name: containerName,
      Image: config.image,
      Env: env,
      HostConfig: {
        Binds: [`${config.workspaceVolume}:/workspace`],
        NetworkMode: config.networkMode ?? "host",
        RestartPolicy: { Name: "unless-stopped" },
      },
      WorkingDir: "/workspace",
    });

    this.containers.set(agentId, container.id);
    logger.info({ agentId, containerId: container.id, image: config.image }, "Agent container created");
  }

  /** Start the agent container. */
  async startAgent(agentId: string): Promise<void> {
    const container = this.getContainer(agentId);
    await container.start();
    logger.info({ agentId }, "Agent container started");
  }

  /** Stop the agent container. */
  async stopAgent(agentId: string): Promise<void> {
    const container = this.getContainer(agentId);
    await container.stop({ t: 10 });
    logger.info({ agentId }, "Agent container stopped");
  }

  /** Restart the agent container. */
  async restartAgent(agentId: string): Promise<void> {
    const container = this.getContainer(agentId);
    await container.restart({ t: 10 });
    logger.info({ agentId }, "Agent container restarted");
  }

  /** Get the current status of an agent container. */
  async getStatus(agentId: string): Promise<ContainerStatus> {
    try {
      const container = this.getContainer(agentId);
      const info = await container.inspect();
      if (info.State.Running) {
        return { state: "running", startedAt: info.State.StartedAt };
      }
      return { state: "stopped", exitCode: info.State.ExitCode };
    } catch {
      return { state: "not_found" };
    }
  }

  /** Get recent logs from the agent container. */
  async getLogs(agentId: string, tail: number = 100): Promise<string> {
    const container = this.getContainer(agentId);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });
    return logs.toString();
  }

  /** Check if a container is running. */
  async isRunning(agentId: string): Promise<boolean> {
    const status = await this.getStatus(agentId);
    return status.state === "running";
  }

  private getContainer(agentId: string): Docker.Container {
    const containerId = this.containers.get(agentId);
    if (!containerId) {
      throw new Error(`No container found for agent: ${agentId}`);
    }
    return this.docker.getContainer(containerId);
  }
}
