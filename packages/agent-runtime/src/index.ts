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

  logger.info({ agentId, kernelUrl, workspacePath }, "CodeClaw Agent Runtime starting...");

  // Initialize subsystems
  const kernelClient = new KernelClient(kernelUrl);
  const injector = new MessageInjector(kernelClient, 500, agentId);
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
  // Host-side port for registering with kernel (may differ from container-internal port)
  const skillHostPort = process.env.SKILL_HOST_PORT ? parseInt(process.env.SKILL_HOST_PORT, 10) : undefined;

  const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

  if (existsSync(skillsDir)) {
    const entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const manifestPath = join(skillsDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const { skillId, entrypoint, type, capabilities } = manifest;
        if (!skillId || !entrypoint) {
          logger.warn({ manifestPath }, "Skipping manifest: missing skillId or entrypoint");
          continue;
        }
        if (!SKILL_ID_RE.test(skillId)) {
          logger.warn({ skillId, manifestPath }, "Skipping manifest: invalid skillId (must match /^[a-z0-9][a-z0-9-]*$/)");
          continue;
        }
        if (!entrypoint.startsWith("/codeclaw/")) {
          logger.warn({ entrypoint, manifestPath }, "Skipping manifest: entrypoint must be under /codeclaw/");
          continue;
        }

        const port = nextPort++;
        const configPath = join(configDir, `${skillId}.json`);
        const command = extname(entrypoint) === ".ts" ? "tsx" : "node";
        const skillType = type ?? "channel";
        const skillCapabilities = capabilities ?? [];

        const registerWithKernel = async () => {
          await kernelClient.registerSkillService({
            skillId,
            type: skillType,
            agentId,
            capabilities: skillCapabilities,
            endpoint: `http://localhost:${skillHostPort ?? port}`,
          });
        };

        await skillServiceManager.start({
          skillId,
          command,
          args: [entrypoint],
          port,
          env: {
            ...(existsSync(configPath) ? { CONFIG_PATH: configPath } : {}),
          },
          onRestart: registerWithKernel,
        });

        // Register with kernel so outbound messages get routed here
        await registerWithKernel();

        logger.info({ skillId, port, entrypoint }, "Auto-started skill from manifest");
      } catch (err) {
        logger.error({ err, manifestPath }, "Failed to start skill from manifest");
      }
    }
  }

  // Assemble MCP server configs from skill manifests (stdio transport)
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};

  if (existsSync(skillsDir)) {
    const mcpEntries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink());

    for (const entry of mcpEntries) {
      const manifestPath = join(skillsDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (!manifest.mcpEntrypoint) continue;

        const service = skillServiceManager.getEndpoint(manifest.skillId);
        mcpServers[manifest.skillId] = {
          command: extname(manifest.mcpEntrypoint) === ".ts" ? "tsx" : "node",
          args: [manifest.mcpEntrypoint],
          env: {
            KERNEL_URL: kernelUrl,
            ...(service ? { SKILL_ENDPOINT: service } : {}),
          },
        };
        logger.info({ skillId: manifest.skillId, mcpEntrypoint: manifest.mcpEntrypoint }, "Registered MCP server from manifest");
      } catch (err) {
        logger.error({ err, manifestPath }, "Failed to read mcpEntrypoint from manifest");
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
      mcpServers,
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
