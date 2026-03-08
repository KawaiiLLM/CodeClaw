import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { logger } from "./logger.js";

export interface KernelConfig {
  kernel: {
    port: number;
    logLevel: string;
  };
  agent: {
    id: string;
    image: string;
    workspaceVolume: string;
    apiKeyEnv: string;
    defaultModel: string;
  };
}

const DEFAULT_CONFIG: KernelConfig = {
  kernel: {
    port: 19000,
    logLevel: "info",
  },
  agent: {
    id: "andy",
    image: "codeclaw/agent-runtime:latest",
    workspaceVolume: "agent-andy-workspace",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "opus",
  },
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
    const agent = parsed.agent as Record<string, unknown> | undefined;

    const config: KernelConfig = {
      kernel: {
        port: (kernel?.port as number) ?? DEFAULT_CONFIG.kernel.port,
        logLevel: (kernel?.log_level as string) ?? DEFAULT_CONFIG.kernel.logLevel,
      },
      agent: {
        id: (agent?.id as string) ?? DEFAULT_CONFIG.agent.id,
        image: (agent?.image as string) ?? DEFAULT_CONFIG.agent.image,
        workspaceVolume: (agent?.workspace_volume as string) ?? DEFAULT_CONFIG.agent.workspaceVolume,
        apiKeyEnv: (agent?.api_key_env as string) ?? DEFAULT_CONFIG.agent.apiKeyEnv,
        defaultModel: (agent?.default_model as string) ?? DEFAULT_CONFIG.agent.defaultModel,
      },
    };

    logger.info({ filePath, agentId: config.agent.id, port: config.kernel.port }, "Config loaded");
    return config;
  } catch (err) {
    logger.error({ filePath, err }, "Failed to parse config, using defaults");
    return DEFAULT_CONFIG;
  }
}
