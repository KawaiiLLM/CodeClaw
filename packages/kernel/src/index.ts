import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { MessageQueue } from "./message-queue.js";
import { IOBridge } from "./io-bridge.js";
import { ContainerManager } from "./container-manager.js";
import { AgentSupervisor } from "./agent-supervisor.js";
import { createHttpServer } from "./http-server.js";

async function main() {
  const startedAt = Date.now();
  const config = loadConfig();

  logger.info("CodeClaw Kernel starting...");

  // Initialize subsystems
  const messageQueue = new MessageQueue();
  const ioBridge = new IOBridge(messageQueue);
  const containerManager = new ContainerManager();
  const supervisor = new AgentSupervisor(containerManager);

  // Start HTTP API
  const server = createHttpServer({
    messageQueue,
    ioBridge,
    supervisor,
    containerManager,
    startedAt,
  });

  server.listen(config.kernel.port, () => {
    logger.info({ port: config.kernel.port }, "Kernel HTTP API listening");
  });

  // Create and start agent containers
  const startedAgents: string[] = [];
  for (const agent of config.agents) {
    try {
      await containerManager.createAgent(agent.id, {
        image: agent.image,
        volume: agent.volume,
        port: agent.port,
        kernelUrl: `http://host.docker.internal:${config.kernel.port}`,
        envFile: agent.envFile,
        extraEnv: agent.extraEnv,
      });
      await containerManager.startAgent(agent.id);
      supervisor.startMonitoring(agent.id);
      startedAgents.push(agent.id);
      logger.info({ agentId: agent.id, port: agent.port }, "Agent container started and monitored");
    } catch (err) {
      logger.warn({ agentId: agent.id, err }, "Could not start agent container (Docker may not be available)");
    }
  }

  if (startedAgents.length === 0) {
    logger.warn("No agent containers started. Kernel running in API-only mode.");
  }

  // Periodic dedup cache cleanup
  setInterval(() => {
    messageQueue.pruneDedup();
  }, 3600_000);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    supervisor.shutdown();
    server.close();
    for (const agentId of startedAgents) {
      try {
        await containerManager.stopAgent(agentId);
      } catch {
        // Container may already be stopped
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info({ agents: startedAgents }, "CodeClaw Kernel ready");
}

main().catch((err) => {
  logger.fatal({ err }, "Kernel startup failed");
  process.exit(1);
});
