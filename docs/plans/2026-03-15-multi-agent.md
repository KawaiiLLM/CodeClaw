# Multi-Agent Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 支持多个 agent 容器，每个绑定不同的 Telegram bot，消息按 agentId 隔离路由。

**Architecture:** 每个 agent = 一个 Docker 容器 + 自己的 bot token + 自己的 volume。Kernel 的 MessageQueue 按 agentId 分区，每个 agent 只消费自己的消息。InboundMessage 由 skill 打上 agentId 标签，Kernel 按标签投递。IOBridge 按 `agentId:channel` 索引服务注册，outbound 消息路由到正确的 skill 实例。Config 从单 `agent` 改为 `agents[]` 数组，向后兼容。

**Tech Stack:** TypeScript ESM, pnpm workspace monorepo, Node.js raw HTTP, dockerode

---

## Task 1: Types — 添加 agentId 字段

**Files:**
- Modify: `packages/types/src/messages.ts:11` — InboundMessage 添加 agentId
- Modify: `packages/types/src/skill-service.ts:5` — SkillServiceRegistration 添加 agentId

**Step 1: 修改 InboundMessage**

在 `packages/types/src/messages.ts` 的 `InboundMessage` 接口中添加可选 `agentId` 字段：

```typescript
export interface InboundMessage {
  id: string;
  channel: string;
  agentId?: string; // Target agent for this message (set by skill or kernel)
  sender: {
    // ... rest unchanged
```

**Step 2: 修改 SkillServiceRegistration**

在 `packages/types/src/skill-service.ts` 中添加 `agentId`：

```typescript
export interface SkillServiceRegistration {
  skillId: string;
  type: "channel" | "tool";
  agentId?: string; // Which agent this service belongs to
  channel?: string;
  capabilities: string[];
  endpoint: string;
}
```

**Step 3: 构建验证**

Run: `cd /Users/zhaoqixuan/Projects/CodeClaw && pnpm -r exec tsc --noEmit 2>&1 | head -20`
Expected: 无编译错误（新字段都是 optional，不破坏现有代码）

**Step 4: Commit**

```bash
git add packages/types/src/messages.ts packages/types/src/skill-service.ts
git commit -m "feat(types): add agentId to InboundMessage and SkillServiceRegistration"
```

---

## Task 2: Config — agents 数组 + 向后兼容

**Files:**
- Modify: `packages/kernel/src/config.ts` — 重写为支持多 agent

**Step 1: 修改 config.ts**

将 `KernelConfig` 改为支持 `agents[]` 数组，同时保持 `agent` 单数形式的向后兼容：

```typescript
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
```

**Step 2: 构建验证**

Run: `pnpm -r exec tsc --noEmit 2>&1 | head -30`
Expected: `index.ts` 会报错（引用了旧的 `config.agent`）—— 这是预期的，Task 6 修复。

**Step 3: Commit**

```bash
git add packages/kernel/src/config.ts
git commit -m "feat(kernel): config supports agents[] array with backward compat"
```

---

## Task 3: MessageQueue — 按 agentId 分区出队

**Files:**
- Modify: `packages/kernel/src/message-queue.ts` — dequeue 支持 agentId 过滤

**Step 1: 修改 MessageQueue**

`dequeue()` 添加可选 `agentId` 参数。有 agentId 时只返回匹配的消息；无 agentId 时返回任意消息（向后兼容）：

```typescript
import type { InboundMessage } from "@codeclaw/types";

interface QueueEntry {
  message: InboundMessage;
  priority: number;
  enqueuedAt: number;
}

const DEFAULT_PRIORITY = 10;

export class MessageQueue {
  private queue: QueueEntry[] = [];
  private seenIds = new Map<string, number>();

  enqueue(msg: InboundMessage, priority: number = DEFAULT_PRIORITY): boolean {
    const dedupeKey = `${msg.channel}:${msg.id}`;
    if (this.seenIds.has(dedupeKey)) {
      return false;
    }
    this.seenIds.set(dedupeKey, Date.now());

    const entry: QueueEntry = {
      message: msg,
      priority,
      enqueuedAt: Date.now(),
    };

    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > priority) {
        insertIdx = i;
        break;
      }
    }
    this.queue.splice(insertIdx, 0, entry);
    return true;
  }

  /** Dequeue the highest-priority message, optionally filtered by agentId. */
  dequeue(agentId?: string): InboundMessage | null {
    if (!agentId) {
      const entry = this.queue.shift();
      return entry?.message ?? null;
    }
    // Find first entry matching agentId
    const idx = this.queue.findIndex((e) => e.message.agentId === agentId);
    if (idx === -1) return null;
    const [entry] = this.queue.splice(idx, 1);
    return entry.message;
  }

  peek(): InboundMessage | null {
    return this.queue[0]?.message ?? null;
  }

  pendingCount(agentId?: string): number {
    if (!agentId) return this.queue.length;
    return this.queue.filter((e) => e.message.agentId === agentId).length;
  }

  pendingByChannel(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.queue) {
      const ch = entry.message.channel;
      result[ch] = (result[ch] ?? 0) + 1;
    }
    return result;
  }

  /** Pending messages grouped by agentId. */
  pendingByAgent(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.queue) {
      const id = entry.message.agentId ?? "_untagged";
      result[id] = (result[id] ?? 0) + 1;
    }
    return result;
  }

  channels(): string[] {
    return Object.keys(this.pendingByChannel());
  }

  pruneDedup(maxAge: number = 3600_000): void {
    const cutoff = Date.now() - maxAge;
    for (const [key, timestamp] of this.seenIds) {
      if (timestamp < cutoff) {
        this.seenIds.delete(key);
      }
    }
  }
}
```

**Step 2: 构建验证**

Run: `pnpm -r exec tsc --noEmit 2>&1 | head -20`
Expected: 无错误（新参数是 optional）

**Step 3: Commit**

```bash
git add packages/kernel/src/message-queue.ts
git commit -m "feat(kernel): MessageQueue supports per-agentId dequeue"
```

---

## Task 4: IOBridge — 按 agentId 索引服务 + inbound 标签

**Files:**
- Modify: `packages/kernel/src/io-bridge.ts` — 服务索引和路由支持 agentId

**Step 1: 修改 IOBridge**

服务索引从 `channel → skillId` 改为 `agentId:channel → skillId`，inbound 消息自动从技能注册中推断 agentId：

```typescript
import type {
  InboundMessage,
  OutboundMessage,
  SkillServiceRegistration,
} from "@codeclaw/types";
import { MessageQueue } from "./message-queue.js";
import { logger } from "./logger.js";

export class IOBridge {
  private services = new Map<string, SkillServiceRegistration>();
  // Index: "agentId:channel" → skillId (with fallback to ":channel" for untagged)
  private channelIndex = new Map<string, string>();

  constructor(private messageQueue: MessageQueue) {}

  /** Register a skill service. Channel-type skills are indexed by agentId + channel. */
  registerService(reg: SkillServiceRegistration): void {
    this.services.set(reg.skillId, reg);
    if (reg.type === "channel") {
      const channelName = reg.channel ?? reg.skillId;
      const key = reg.agentId ? `${reg.agentId}:${channelName}` : `:${channelName}`;
      this.channelIndex.set(key, reg.skillId);
    }
    logger.info(
      { skillId: reg.skillId, type: reg.type, agentId: reg.agentId, channel: reg.channel, endpoint: reg.endpoint },
      "Skill service registered",
    );
  }

  /** Unregister a skill service. */
  unregisterService(skillId: string): void {
    const reg = this.services.get(skillId);
    if (reg) {
      if (reg.type === "channel") {
        const channelName = reg.channel ?? reg.skillId;
        const key = reg.agentId ? `${reg.agentId}:${channelName}` : `:${channelName}`;
        this.channelIndex.delete(key);
      }
      this.services.delete(skillId);
      logger.info({ skillId }, "Skill service unregistered");
    }
  }

  /** Look up the skill service for a given channel, optionally scoped to an agent. */
  getServiceForChannel(channel: string, agentId?: string): SkillServiceRegistration | null {
    // Try agent-specific first
    if (agentId) {
      const skillId = this.channelIndex.get(`${agentId}:${channel}`);
      if (skillId) return this.services.get(skillId) ?? null;
    }
    // Fallback: untagged (single-agent compat)
    const skillId = this.channelIndex.get(`:${channel}`);
    if (skillId) return this.services.get(skillId) ?? null;
    // Legacy fallback: try skillId directly
    return this.services.get(channel) ?? null;
  }

  /** Get all registered services. */
  getAllServices(): Record<string, SkillServiceRegistration> {
    return Object.fromEntries(this.services);
  }

  /** Handle an inbound message from a skill service → push to message queue. */
  handleInbound(msg: InboundMessage): boolean {
    const enqueued = this.messageQueue.enqueue(msg);
    if (enqueued) {
      logger.debug({ channel: msg.channel, agentId: msg.agentId, msgId: msg.id, sender: msg.sender.name }, "Inbound message enqueued");
    } else {
      logger.debug({ channel: msg.channel, msgId: msg.id }, "Inbound message deduplicated");
    }
    return enqueued;
  }

  /** Route an outbound message to the appropriate skill service. */
  async routeOutbound(msg: OutboundMessage & { agentId?: string }): Promise<Record<string, unknown>> {
    const service = this.getServiceForChannel(msg.channel, msg.agentId);
    if (!service) {
      throw new Error(`No skill service registered for channel: ${msg.channel} (agentId: ${msg.agentId ?? "none"})`);
    }

    // Custom Skill endpoint: transparent pass-through
    if (msg.skillEndpoint) {
      const url = `${service.endpoint}${msg.skillEndpoint}`;
      logger.debug({ channel: msg.channel, conversation: msg.conversation, endpoint: url }, "Routing to custom skill endpoint");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation: msg.conversation, ...msg.payload }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Skill service ${service.skillId} returned ${res.status}: ${body}`);
      }
      return (await res.json()) as Record<string, unknown>;
    }

    // Standard message routing: /edit or /send
    const route = msg.editMessageId ? "/edit" : "/send";
    const url = `${service.endpoint}${route}`;
    logger.debug({ channel: msg.channel, conversation: msg.conversation, endpoint: url, route }, "Routing outbound message");

    let payload: unknown;
    if (msg.editMessageId) {
      if (msg.content.type !== "text") {
        throw new Error("editMessageId is only supported for text content");
      }
      payload = { conversation: msg.conversation, messageId: Number(msg.editMessageId), text: msg.content.text };
    } else {
      payload = msg;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Skill service ${service.skillId} returned ${res.status}: ${body}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }
}
```

**Step 2: 构建验证**

Run: `pnpm -r exec tsc --noEmit 2>&1 | head -20`
Expected: 无错误

**Step 3: Commit**

```bash
git add packages/kernel/src/io-bridge.ts
git commit -m "feat(kernel): IOBridge indexes services by agentId:channel"
```

---

## Task 5: HTTP Server — agentId 路由参数

**Files:**
- Modify: `packages/kernel/src/http-server.ts` — GET /api/messages/next 支持 agentId query param

**Step 1: 修改 HTTP Server**

修改路由匹配逻辑，解析 URL query params。修改 `/api/messages/next` 和 `/api/messages/outbound`：

在 `http-server.ts` 中，修改 GET 路由的 `/api/messages/next` handler 和路由匹配逻辑：

```typescript
// 替换现有的 server 创建和路由匹配部分

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const parsedUrl = new URL(rawUrl, `http://${req.headers.host ?? "localhost"}`);
    const url = parsedUrl.pathname;

    // CORS headers
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const handler = routes[method]?.[url];
    if (!handler) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found", path: url }));
      return;
    }

    try {
      let body: unknown = {};
      if (method === "POST") {
        body = await parseJsonBody(req);
      }

      const result = await handler(body, parsedUrl.searchParams);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      // ... error handling unchanged
    }
  });
```

路由 handler 签名改为接收 `searchParams`：

```typescript
type RouteHandler = (body: unknown, params?: URLSearchParams) => Promise<unknown>;
```

修改 `/api/messages/next`：

```typescript
"/api/messages/next": async (_body, params) => {
  const agentId = params?.get("agentId") ?? undefined;
  const msg = messageQueue.dequeue(agentId);
  return msg ?? { empty: true };
},
```

修改 `/api/messages/queue`：

```typescript
"/api/messages/queue": async () => {
  return {
    pending: messageQueue.pendingCount(),
    channels: messageQueue.channels(),
    byChannel: messageQueue.pendingByChannel(),
    byAgent: messageQueue.pendingByAgent(),
  };
},
```

**Step 2: 构建验证**

Run: `pnpm -r exec tsc --noEmit 2>&1 | head -20`
Expected: 无错误

**Step 3: Commit**

```bash
git add packages/kernel/src/http-server.ts
git commit -m "feat(kernel): /api/messages/next supports agentId query param"
```

---

## Task 6: Kernel 启动 — 多容器循环

**Files:**
- Modify: `packages/kernel/src/index.ts` — 循环启动多个 agent 容器
- Modify: `packages/kernel/src/container-manager.ts:48-89` — createAgent 适配新 config

**Step 1: 修改 container-manager.ts 的 createAgent**

简化 `AgentContainerConfig`，直接接受新的 `AgentConfig` 字段：

```typescript
export interface AgentContainerConfig {
  image: string;
  volume: string;
  kernelUrl: string;
  port: number; // Host port to map to container's 7001
  envFile?: string;
  extraEnv?: Record<string, string>;
}
```

修改 `createAgent` 中的环境变量和端口映射：

```typescript
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
        NetworkMode: "host",
        RestartPolicy: { Name: "unless-stopped" },
        PortBindings: {
          "7001/tcp": [{ HostPort: String(config.port) }],
        },
      },
      ExposedPorts: { "7001/tcp": {} },
      WorkingDir: "/home/codeclaw",
    });

    this.containers.set(agentId, container.id);
    logger.info({ agentId, containerId: container.id, image: config.image, port: config.port }, "Agent container created");
  }
```

> **注意**: `PortBindings` 只在非 `host` NetworkMode 下生效。当前用 `host` 模式时端口直接暴露。如果需要端口隔离，需切换到 `bridge` 模式。多 agent 场景下建议后续改为 bridge + 端口映射。当前阶段先保留 host 模式，因为仅部署一个 agent 容器。

**Step 2: 修改 index.ts — 多 agent 启动循环**

```typescript
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
      logger.warn({ agentId: agent.id, err }, "Could not start agent container");
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
```

**Step 3: 构建验证**

Run: `pnpm -r exec tsc --noEmit 2>&1 | head -20`
Expected: 无错误

**Step 4: Commit**

```bash
git add packages/kernel/src/index.ts packages/kernel/src/container-manager.ts
git commit -m "feat(kernel): start multiple agent containers from agents[] config"
```

---

## Task 7: Agent Runtime — agentId 贯穿 skill 注册 + 消息轮询

**Files:**
- Modify: `packages/agent-runtime/src/kernel-client.ts:18-25` — getNextMessage 带 agentId
- Modify: `packages/agent-runtime/src/index.ts:70-77` — 注册时带 agentId
- Modify: `skills/telegram/service.ts:27,479` — forwardToKernel 带 agentId

**Step 1: KernelClient — getNextMessage 带 agentId**

修改 `packages/agent-runtime/src/kernel-client.ts` 的 `getNextMessage` 方法：

```typescript
/** Fetch the next inbound message from the kernel queue. */
async getNextMessage(agentId?: string): Promise<InboundMessage | null> {
  const path = agentId ? `/api/messages/next?agentId=${encodeURIComponent(agentId)}` : "/api/messages/next";
  const res = (await this.get(path)) as Record<string, unknown>;
  if ("empty" in res && res.empty === true) {
    return null;
  }
  return res as unknown as InboundMessage;
}
```

**Step 2: MessageInjector — 传递 agentId**

修改 `packages/agent-runtime/src/message-injector.ts` 的构造函数和 poll 方法：

```typescript
constructor(
  private kernelClient: KernelClient,
  private pollIntervalMs: number = 500,
  private agentId?: string,
) {}
```

修改 `poll()` 方法：

```typescript
private async poll(): Promise<void> {
  while (true) {
    const msg = await this.kernelClient.getNextMessage(this.agentId);
    if (!msg) break;
    logger.debug({ channel: msg.channel, sender: msg.sender.name }, "Polled message from kernel");
    this.push(msg);
  }
}
```

**Step 3: index.ts — 传 agentId 给 MessageInjector 和 skill 注册**

修改 `packages/agent-runtime/src/index.ts` 中 MessageInjector 构造：

```typescript
const injector = new MessageInjector(kernelClient, 500, agentId);
```

修改 skill 注册的 `registerWithKernel`（约第 70 行）：

```typescript
const registerWithKernel = async () => {
  await kernelClient.registerSkillService({
    skillId,
    type: skillType,
    agentId,
    capabilities: skillCapabilities,
    endpoint: `http://localhost:${port}`,
  });
};
```

**Step 4: Telegram Skill — forwardToKernel 带 agentId**

修改 `skills/telegram/service.ts`。在文件顶部 CONFIG 区域（约第 28 行）添加：

```typescript
const AGENT_ID = process.env.AGENT_ID;
```

找到 `forwardToKernel` 函数调用处（约第 479 行的 `await forwardToKernel({...})`），在所有调用中添加 `agentId` 字段。找到 `forwardToKernel` 函数定义，在构建请求 body 时加入 `agentId`：

```typescript
// 在 forwardToKernel 函数中，构建 InboundMessage 时添加：
agentId: AGENT_ID,
```

具体修改取决于 `forwardToKernel` 的实现位置。搜索该函数定义，在 message body 中添加 `agentId: AGENT_ID`。

**Step 5: 构建验证**

Run: `pnpm -r exec tsc --noEmit 2>&1 | head -20`
Expected: 无错误

**Step 6: Commit**

```bash
git add packages/agent-runtime/src/kernel-client.ts packages/agent-runtime/src/message-injector.ts packages/agent-runtime/src/index.ts skills/telegram/service.ts
git commit -m "feat(agent-runtime): agentId flows through polling, skill registration, and inbound messages"
```

---

## Task 8: 部署脚本 — 多 agent 支持

**Files:**
- Modify: `scripts/deploy.sh` — 参数化 agent，支持多 agent 部署

**Step 1: 修改 deploy.sh**

改为接受 agent 名称参数，默认 `andy`。支持 `--all` 部署所有配置的 agent：

```bash
#!/usr/bin/env bash
set -euo pipefail

# CodeClaw Agent 部署脚本
# 用法:
#   ./scripts/deploy.sh [--build] [--logs] [AGENT_ID]
#   ./scripts/deploy.sh --build andy        # 构建并部署 andy
#   ./scripts/deploy.sh bob                 # 部署 bob（不构建）

IMAGE="codeclaw/agent-runtime:dev"
DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export DOCKER_HOST

# --- 参数解析 ---
BUILD=false
LOGS=false
AGENT_ID=""
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=true ;;
    --logs)  LOGS=true ;;
    -*) echo "Unknown flag: $arg"; exit 1 ;;
    *) AGENT_ID="$arg" ;;
  esac
done

AGENT_ID="${AGENT_ID:-andy}"
CONTAINER_NAME="codeclaw-agent-${AGENT_ID}"
VOLUME="codeclaw-${AGENT_ID}-home"
ENV_FILE="$HOME/.claude/config/agent-${AGENT_ID}.env"

# Fallback to legacy env file for 'andy'
if [ ! -f "$ENV_FILE" ] && [ "$AGENT_ID" = "andy" ]; then
  ENV_FILE="$HOME/.claude/config/agent.env"
fi

# --- 前置检查 ---
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE"
  echo "Should contain ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker not available. Is Colima running?"
  echo "  colima start"
  exit 1
fi

# --- 构建镜像 ---
if [ "$BUILD" = true ]; then
  echo "==> Building image..."
  docker build -t "$IMAGE" -f packages/agent-runtime/Dockerfile.dev .
fi

# --- 确认 volume 存在 ---
if ! docker volume ls -q | grep -q "^${VOLUME}$"; then
  echo "WARNING: Volume $VOLUME does not exist, will be created fresh"
fi

# --- 停止旧容器 ---
if docker ps -q --filter "name=$CONTAINER_NAME" | grep -q .; then
  echo "==> Stopping $CONTAINER_NAME..."
  docker stop "$CONTAINER_NAME"
fi
docker rm "$CONTAINER_NAME" 2>/dev/null || true

# --- 端口映射（andy=7001, 其他按名称 hash 或手动指定）---
PORT="${DEPLOY_PORT:-7001}"

# --- 启动 ---
echo "==> Starting $CONTAINER_NAME (agent=$AGENT_ID, port=$PORT)..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --env-file "$ENV_FILE" \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID="$AGENT_ID" \
  -e CLAUDE_MODEL=aws-claude-opus-4-6 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  -v "$VOLUME":/home/codeclaw \
  -p "$PORT":7001 \
  "$IMAGE"

# --- 验证 ---
sleep 2
STATUS=$(docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}')
PORTS=$(docker ps --filter "name=$CONTAINER_NAME" --format '{{.Ports}}')

if echo "$STATUS" | grep -q "Up"; then
  echo "==> OK: $CONTAINER_NAME is running"
  echo "    Agent:  $AGENT_ID"
  echo "    Status: $STATUS"
  echo "    Ports:  $PORTS"
  echo "    Volume: $VOLUME"
else
  echo "ERROR: Container failed to start"
  docker logs --tail 30 "$CONTAINER_NAME"
  exit 1
fi

# --- 可选: 跟踪日志 ---
if [ "$LOGS" = true ]; then
  echo "==> Following logs (Ctrl+C to stop)..."
  docker logs -f "$CONTAINER_NAME"
fi
```

**Step 2: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat: deploy.sh supports multi-agent via AGENT_ID parameter"
```

---

## 验证清单

部署第二个 agent（假设 id=`bob`）的完整流程：

1. **创建 volume**: `docker volume create codeclaw-bob-home`
2. **创建 env 文件**: `cp ~/.claude/config/agent.env ~/.claude/config/agent-bob.env`，修改 bot token
3. **创建 bot token 配置**: 在 bob 的 volume 中放置 `~/.claude/config/telegram.json`，填入 bob 的 bot token
4. **部署**: `DEPLOY_PORT=7002 ./scripts/deploy.sh --build bob`
5. **验证 Kernel 状态**: `curl http://localhost:19000/api/status` — 应看到两个 services 注册
6. **验证消息隔离**: 分别向两个 bot 发消息，各自独立回复
7. **验证 typing**: 两个 bot 分别有独立的 typing 指示器

## 不变更的文件

- `agent-loop.ts` — 无需修改，agentId 已通过 env 传入
- `agent-supervisor.ts` — 已支持多 agent（Map<agentId, AgentState>）
- `mcp-server.ts` — AGENT_ID 已从 env 读取
- `Dockerfile.dev` — 通用镜像，通过 env 区分 agent

## 后续扩展（不在本计划范围）

- **codeclaw.yaml 示例配置**: 写一个多 agent 配置示例
- **bridge 网络模式**: 从 host 模式切换到 bridge + 端口映射，实现真正的网络隔离
- **bindings[] 声明式路由**: 更灵活的消息路由（按 channel/peer/group 匹配），类似 OpenClaw
- **CLI 管理命令**: `codeclaw agents add/remove/list`
- **Web UI**: 多 agent 状态面板
