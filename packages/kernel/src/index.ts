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

  // Create and start agent container
  const { agent } = config;
  try {
    await containerManager.createAgent(agent.id, {
      image: agent.image,
      workspaceVolume: agent.workspaceVolume,
      apiKeyEnv: agent.apiKeyEnv,
      kernelUrl: `http://host.docker.internal:${config.kernel.port}`,
    });
    await containerManager.startAgent(agent.id);
    supervisor.startMonitoring(agent.id);
    logger.info({ agentId: agent.id }, "Agent container started and monitored");
  } catch (err) {
    logger.warn({ agentId: agent.id, err }, "Could not start agent container (Docker may not be available). Kernel running in API-only mode.");
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
    try {
      await containerManager.stopAgent(agent.id);
    } catch {
      // Container may already be stopped
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("CodeClaw Kernel ready");
}

main().catch((err) => {
  logger.fatal({ err }, "Kernel startup failed");
  process.exit(1);
});
