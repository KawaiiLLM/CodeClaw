import Docker from "dockerode";
import { logger } from "./logger.js";

export interface AgentContainerConfig {
  image: string;
  volume: string;
  kernelUrl: string;
  port: number; // Host port to map to container's 7001
  envFile?: string;
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
    // Support Colima and other non-default Docker socket paths
    const socketPath = process.env.DOCKER_HOST?.replace("unix://", "")
      ?? this.findDockerSocket();
    this.docker = socketPath ? new Docker({ socketPath }) : new Docker();
  }

  private findDockerSocket(): string | undefined {
    const candidates = [
      "/var/run/docker.sock",
      `${process.env.HOME}/.colima/default/docker.sock`,
      `${process.env.HOME}/.colima/docker.sock`,
    ];
    for (const sock of candidates) {
      try {
        const fs = require("node:fs");
        fs.accessSync(sock);
        return sock;
      } catch {
        continue;
      }
    }
    return undefined;
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
      `KERNEL_URL=${config.kernelUrl}`,
      `AGENT_ID=${agentId}`,
      ...Object.entries(config.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
    ];

    // Read env file if specified (contains API keys etc.)
    if (config.envFile) {
      try {
        const { readFileSync } = await import("node:fs");
        const lines = readFileSync(config.envFile, "utf-8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"));
        env.push(...lines);
      } catch (err) {
        logger.warn({ agentId, envFile: config.envFile, err }, "Failed to read env file");
      }
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: config.image,
      Env: env,
      HostConfig: {
        Binds: [`${config.volume}:/home/codeclaw`],
        NetworkMode: config.networkMode ?? "host",
        RestartPolicy: { Name: "unless-stopped" },
      },
      WorkingDir: "/home/codeclaw",
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
