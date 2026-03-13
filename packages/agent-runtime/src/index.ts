import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { KernelClient } from "./kernel-client.js";
import { MessageInjector } from "./message-injector.js";
import { SkillServiceManager } from "./skill-service-manager.js";
import { startAgentLoop } from "./agent-loop.js";
import { logger } from "./logger.js";

async function main() {
  const agentId = process.env.AGENT_ID ?? "andy";
  const kernelUrl = process.env.KERNEL_URL ?? "http://localhost:19000";
  const workspacePath = process.env.HOME ?? "/home/codeclaw";
  const resumeSessionId = process.env.RESUME_SESSION_ID;

  logger.info({ agentId, kernelUrl, workspacePath }, "CodeClaw Agent Runtime starting...");

  // Initialize subsystems
  const kernelClient = new KernelClient(kernelUrl);
  const injector = new MessageInjector(kernelClient);
  const skillServiceManager = new SkillServiceManager(kernelClient);

  // Graceful shutdown — registered inside main() so cleanup runs properly
  const shutdown = async () => {
    logger.info("Shutting down...");
    injector.stop();
    await skillServiceManager.stopAll();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Auto-start installed skills from manifests
  const skillsDir = join(workspacePath, ".claude", "skills");
  const configDir = join(workspacePath, ".claude", "config");
  const PORT_BASE = 7001;
  let nextPort = PORT_BASE;

  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(skillsDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const { skillId, entrypoint, type, capabilities } = manifest;
        if (!skillId || !entrypoint) {
          logger.warn({ manifestPath }, "Skipping manifest: missing skillId or entrypoint");
          continue;
        }

        const port = nextPort++;
        const configPath = join(configDir, `${skillId}.json`);
        const command = extname(entrypoint) === ".ts" ? "tsx" : "node";

        await skillServiceManager.start({
          skillId,
          command,
          args: [entrypoint],
          port,
          env: {
            ...(existsSync(configPath) ? { CONFIG_PATH: configPath } : {}),
          },
        });

        // Register with kernel so outbound messages get routed here
        await kernelClient.registerSkillService({
          skillId,
          type: type ?? "channel",
          capabilities: capabilities ?? [],
          endpoint: `http://localhost:${port}`,
        });

        logger.info({ skillId, port, entrypoint }, "Auto-started skill from manifest");
      } catch (err) {
        logger.error({ err, manifestPath }, "Failed to start skill from manifest");
      }
    }
  }

  // Start polling kernel for messages
  injector.start();

  // Start the agent loop
  try {
    await startAgentLoop({
      injector,
      kernelClient,
      agentId,
      workspacePath,
      resumeSessionId,
      skillServiceManager,
    });
  } catch (err) {
    logger.fatal({ err }, "Agent loop crashed");
  } finally {
    injector.stop();
    await skillServiceManager.stopAll();
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Agent runtime startup failed");
  process.exit(1);
});
