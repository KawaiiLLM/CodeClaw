import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { logger } from "./logger.js";

export interface AgentConfig {
  id: string;
  image: string;
  volume: string;
  port: number; // Skill service port mapping (host:container)
  envFile?: string; // Path to env file with API key etc.
  extraEnv?: Record<string, string>;
}

export interface KernelConfig {
  kernel: {
    port: number;
    logLevel: string;
  };
  agents: AgentConfig[];
}

const DEFAULT_CONFIG: KernelConfig = {
  kernel: {
    port: 19000,
    logLevel: "info",
  },
  agents: [
    {
      id: "andy",
      image: "codeclaw/agent-runtime:dev",
      volume: "codeclaw-andy-home",
      port: 7001,
    },
  ],
};

export function loadConfig(configPath?: string): KernelConfig {
  const filePath = configPath ?? resolve(process.cwd(), "codeclaw.yaml");

  if (!existsSync(filePath)) {
    logger.warn({ filePath }, "Config file not found, using defaults");
    return DEFAULT_CONFIG;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;

    const kernel = parsed.kernel as Record<string, unknown> | undefined;

    // Support both old single-agent and new multi-agent config
    let agents: AgentConfig[];
    if (Array.isArray(parsed.agents)) {
      agents = (parsed.agents as Record<string, unknown>[]).map((a) => ({
        id: (a.id as string) ?? "andy",
        image: (a.image as string) ?? "codeclaw/agent-runtime:dev",
        volume: (a.volume as string) ?? `codeclaw-${a.id ?? "andy"}-home`,
        port: (a.port as number) ?? 7001,
        envFile: a.env_file as string | undefined,
        extraEnv: a.extra_env as Record<string, string> | undefined,
      }));
    } else {
      // Backward compat: old single "agent:" key
      const agent = parsed.agent as Record<string, unknown> | undefined;
      agents = [
        {
          id: (agent?.id as string) ?? "andy",
          image: (agent?.image as string) ?? "codeclaw/agent-runtime:dev",
          volume: (agent?.workspace_volume as string) ?? "codeclaw-andy-home",
          port: 7001,
        },
      ];
    }

    const config: KernelConfig = {
      kernel: {
        port: (kernel?.port as number) ?? DEFAULT_CONFIG.kernel.port,
        logLevel: (kernel?.log_level as string) ?? DEFAULT_CONFIG.kernel.logLevel,
      },
      agents,
    };

    logger.info(
      { filePath, agentCount: config.agents.length, agentIds: config.agents.map((a) => a.id) },
      "Config loaded",
    );
    return config;
  } catch (err) {
    logger.error({ filePath, err }, "Failed to parse config, using defaults");
    return DEFAULT_CONFIG;
  }
}
