import { KernelClient } from "./kernel-client.js";
import { MessageInjector } from "./message-injector.js";
import { SkillServiceManager } from "./skill-service-manager.js";
import { startAgentLoop } from "./agent-loop.js";
import { logger } from "./logger.js";

async function main() {
  const agentId = process.env.AGENT_ID ?? "andy";
  const kernelUrl = process.env.KERNEL_URL ?? "http://localhost:19000";
  const workspacePath = process.env.WORKSPACE_PATH ?? "/workspace";
  const mcpServerPath = process.env.MCP_SERVER_PATH ?? "/app/mcp-entry.js";
  const resumeSessionId = process.env.RESUME_SESSION_ID;

  logger.info({ agentId, kernelUrl, workspacePath }, "CodeClaw Agent Runtime starting...");

  // Initialize subsystems
  const kernelClient = new KernelClient(kernelUrl);
  const injector = new MessageInjector(kernelClient);
  const skillServiceManager = new SkillServiceManager(kernelClient);

  // Start polling kernel for messages
  injector.start();

  // Start the agent loop
  try {
    await startAgentLoop({
      injector,
      kernelClient,
      agentId,
      workspacePath,
      mcpServerPath,
      resumeSessionId,
    });
  } catch (err) {
    logger.fatal({ err }, "Agent loop crashed");
  } finally {
    injector.stop();
    await skillServiceManager.stopAll();
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT, shutting down...");
  process.exit(0);
});

main().catch((err) => {
  logger.fatal({ err }, "Agent runtime startup failed");
  process.exit(1);
});
