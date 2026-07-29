import assert from "node:assert/strict";
import test from "node:test";
import type { InboundMessage } from "@codeclaw/types";
import { startAgentLoop } from "./agent-loop.js";
import { MessageInjector } from "./message-injector.js";

const originalSetInterval = globalThis.setInterval;
const originalSetTimeout = globalThis.setTimeout;
const originalApiKey = process.env.ANTHROPIC_API_KEY;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const timer = originalSetInterval(...args);
  timer.unref();
  return timer;
}) as typeof setInterval;
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  const timer = originalSetTimeout(...args);
  timer.unref();
  return timer;
}) as typeof setTimeout;
process.env.ANTHROPIC_API_KEY = "test-key";
test.after(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.setTimeout = originalSetTimeout;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

function runtimeMessage(command: string, args = ""): InboundMessage {
  return {
    id: `${command}-${args}`,
    channel: "test",
    sender: { id: "user", name: "User", channel: "test" },
    conversation: { id: "conversation", type: "dm" },
    content: { type: "text", text: [command, args].filter(Boolean).join(" ") },
    timestamp: 0,
    metadata: { command, args, raw: [command, args].filter(Boolean).join(" ") },
  };
}

function userMessage(text: string): InboundMessage {
  const message = runtimeMessage(text);
  delete message.metadata;
  return message;
}

function malformedMessage(): InboundMessage {
  return { ...userMessage("malformed"), content: undefined as any };
}

function quietKernelClient() {
  return { reportHealth: async () => {}, sendMessage: async () => ({}) };
}

async function waitFor(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function within<T>(promise: Promise<T>, milliseconds = 1_500): Promise<T> {
  let timer: ReturnType<typeof originalSetTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = originalSetTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createQueryTracker({ holdDiaryResult = false, closeError = false } = {}) {
  const events: string[] = [];
  const inputs: Array<{ options: Record<string, unknown> }> = [];
  const closeCounts = new Map<number, number>();
  let created = 0;
  let live = 0;
  let maxLive = 0;
  let releaseDiaryResult!: () => void;
  const diaryResultReleased = new Promise<void>((resolve) => { releaseDiaryResult = resolve; });

  return {
    events,
    inputs,
    get created() { return created; },
    get live() { return live; },
    get maxLive() { return maxLive; },
    closeCount(id: number) { return closeCounts.get(id) ?? 0; },
    releaseDiaryResult,
    create(input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) {
      const id = ++created;
      inputs.push({ options: input.options });
      live += 1;
      maxLive = Math.max(maxLive, live);
      events.push(`create:${id}`);
      let close!: () => void;
      const closed = new Promise<void>((resolve) => { close = resolve; });
      let isClosed = false;
      return {
        async interrupt() { events.push(`interrupt:${id}`); },
        close() {
          closeCounts.set(id, (closeCounts.get(id) ?? 0) + 1);
          if (!isClosed) {
            isClosed = true;
            live -= 1;
            events.push(`close:${id}`);
            close();
          }
          if (closeError) throw new Error("close failed");
        },
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: `session-${id}`, model: "test", tools: [], mcp_servers: [] };
          const iterator = input.prompt[Symbol.asyncIterator]();
          while (true) {
            const next = await Promise.race([
              iterator.next(),
              closed.then(() => ({ done: true, value: undefined })),
            ]);
            if (next.done) return;
            events.push(`prompt:${id}`);
            if (holdDiaryResult && id === 2) await diaryResultReleased;
            if (isClosed) return;
            events.push(`result:${id}`);
            yield {
              type: "result", subtype: "success", session_id: `session-${id}`, total_cost_usd: 0,
              num_turns: 1, duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 },
            };
          }
        },
      };
    },
  };
}

async function expectPumpFailure(loop: Promise<void>): Promise<void> {
  await assert.rejects(within(loop), /Cannot read properties of undefined/);
}

test("a malformed inbound while the Query is idle closes it and rejects the agent loop", { timeout: 2_000 }, async () => {
  const tracker = createQueryTracker();
  const injector = new MessageInjector(quietKernelClient() as any);
  injector.push(userMessage("first"));
  const loop = startAgentLoop({ injector, kernelClient: quietKernelClient() as any, agentId: "test-agent", workspacePath: "/tmp", mcpServers: {}, queryFactory: tracker.create as any });

  await waitFor("completed first turn", () => tracker.events.includes("result:1"));
  injector.push(malformedMessage());

  await expectPumpFailure(loop);
  assert.equal(tracker.closeCount(1), 1);
  assert.equal(tracker.created, 1);
  assert.equal(tracker.live, 0);
});

test("a Query close failure rejects the loop without creating a replacement", { timeout: 2_000 }, async () => {
  const tracker = createQueryTracker({ closeError: true });
  const injector = new MessageInjector(quietKernelClient() as any);
  injector.push(userMessage("first"));
  const loop = startAgentLoop({ injector, kernelClient: quietKernelClient() as any, agentId: "test-agent", workspacePath: "/tmp", mcpServers: {}, queryFactory: tracker.create as any });

  await waitFor("completed first turn", () => tracker.events.includes("result:1"));
  injector.push(malformedMessage());

  await assert.rejects(within(loop), /close failed/);
  assert.equal(tracker.closeCount(1), 1);
  assert.equal(tracker.created, 1);
  assert.equal(tracker.live, 0);
});

test("an initial /session new creates only the replacement Query", { timeout: 2_000 }, async () => {
  const tracker = createQueryTracker();
  const injector = new MessageInjector(quietKernelClient() as any);
  injector.push(runtimeMessage("/session", "new"));
  injector.push(userMessage("first"));
  const loop = startAgentLoop({ injector, kernelClient: quietKernelClient() as any, agentId: "test-agent", workspacePath: "/tmp", mcpServers: {}, queryFactory: tracker.create as any });

  await waitFor("replacement result", () => tracker.events.includes("result:1"));
  injector.push(malformedMessage());

  await expectPumpFailure(loop);
  assert.deepEqual(tracker.events.filter((event) => event.startsWith("create:") || event.startsWith("interrupt:")), ["create:1"]);
  assert.equal(tracker.closeCount(1), 1);
  assert.equal(tracker.created, 1);
  assert.equal(tracker.maxLive, 1);
  assert.equal(tracker.live, 0);
});

test("a session switch closes before its replacement and the awaited loop has no live Query", { timeout: 2_000 }, async () => {
  const tracker = createQueryTracker();
  const injector = new MessageInjector(quietKernelClient() as any);
  injector.push(userMessage("first"));
  const loop = startAgentLoop({ injector, kernelClient: quietKernelClient() as any, agentId: "test-agent", workspacePath: "/tmp", mcpServers: {}, queryFactory: tracker.create as any });

  await waitFor("first result", () => tracker.events.includes("result:1"));
  injector.push(runtimeMessage("/session", "new"));
  await waitFor("first Query closure", () => tracker.events.includes("close:1"));
  injector.push(userMessage("second"));
  await waitFor("replacement result", () => tracker.events.includes("result:2"));
  injector.push(malformedMessage());

  await expectPumpFailure(loop);
  assert.ok(tracker.events.indexOf("close:1") < tracker.events.indexOf("create:2"));
  assert.equal(tracker.closeCount(1), 1);
  assert.equal(tracker.closeCount(2), 1);
  assert.equal(tracker.maxLive, 1);
  assert.equal(tracker.live, 0);
});

test("a diary Query is non-persistent, requeues user input, and closes before session resume", { timeout: 2_000 }, async () => {
  const tracker = createQueryTracker({ holdDiaryResult: true });
  const injector = new MessageInjector(quietKernelClient() as any);
  injector.push(userMessage("before diary"));
  const loop = startAgentLoop({ injector, kernelClient: quietKernelClient() as any, agentId: "test-agent", workspacePath: "/tmp", mcpServers: {}, queryFactory: tracker.create as any });

  await waitFor("first result", () => tracker.events.includes("result:1"));
  injector.push(runtimeMessage("/diary"));
  await waitFor("diary prompt", () => tracker.events.includes("prompt:2"));
  injector.push(userMessage("during diary"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  tracker.releaseDiaryResult();
  await waitFor("resumed Query result", () => tracker.events.includes("result:3"));
  injector.push(malformedMessage());

  await expectPumpFailure(loop);
  assert.equal(tracker.inputs[1].options.persistSession, false);
  assert.equal(tracker.inputs[2].options.resume, "session-1");
  assert.ok(tracker.events.indexOf("close:2") < tracker.events.indexOf("create:3"));
  assert.equal(tracker.closeCount(1), 1);
  assert.equal(tracker.closeCount(2), 1);
  assert.equal(tracker.closeCount(3), 1);
  assert.equal(tracker.maxLive, 1);
  assert.equal(tracker.live, 0);
});
