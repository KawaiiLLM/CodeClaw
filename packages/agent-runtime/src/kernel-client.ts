import type {
  InboundMessage,
  OutboundMessage,
  QueueStatus,
  SkillServiceRegistration,
} from "@codeclaw/types";

/**
 * HTTP client for communicating with the CodeClaw kernel.
 */
export class KernelClient {
  private baseUrl: string;
  private agentId?: string;

  constructor(kernelUrl?: string, agentId?: string) {
    this.baseUrl = kernelUrl ?? process.env.KERNEL_URL ?? "http://localhost:19000";
    this.agentId = agentId;
  }

  /** Fetch the next inbound message from the kernel queue. */
  async getNextMessage(agentId?: string): Promise<InboundMessage | null> {
    const path = agentId ? `/api/messages/next?agentId=${encodeURIComponent(agentId)}` : "/api/messages/next";
    const res = (await this.get(path)) as Record<string, unknown>;
    if ("empty" in res && res.empty === true) {
      return null;
    }
    return res as unknown as InboundMessage;
  }

  /** Send an outbound message through the kernel. Returns Skill response (e.g. messageId). */
  async sendMessage(msg: OutboundMessage): Promise<{ messageId?: string } & Record<string, unknown>> {
    const payload = this.agentId && !msg.agentId ? { ...msg, agentId: this.agentId } : msg;
    const res = await this.post("/api/messages/outbound", payload);
    return res as { messageId?: string } & Record<string, unknown>;
  }

  /** Get the current message queue status. */
  async getQueueStatus(): Promise<QueueStatus> {
    return (await this.get("/api/messages/queue")) as QueueStatus;
  }

  /** Register a skill service with the kernel. */
  async registerSkillService(reg: SkillServiceRegistration): Promise<void> {
    await this.post("/api/services/register", reg);
  }

  /** Unregister a skill service. */
  async unregisterSkillService(skillId: string): Promise<void> {
    await this.post("/api/services/unregister", { skillId });
  }

  /** Route an outbound operation to a custom Skill endpoint via the kernel. */
  async sendOutbound(msg: {
    channel: string;
    conversation: string;
    skillEndpoint: string;
    payload: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const res = await this.post("/api/messages/outbound", {
      channel: msg.channel,
      agentId: this.agentId,
      conversation: msg.conversation,
      content: { type: "text", text: "" },
      skillEndpoint: msg.skillEndpoint,
      payload: msg.payload,
    });
    return res as Record<string, unknown>;
  }

  /** Report agent health to the kernel. */
  async reportHealth(
    agentId: string,
    status: "alive" | "busy" | "idle",
    extra?: { sessionId?: string; lastAssistantMessageId?: string; conversation?: string },
  ): Promise<void> {
    await this.post("/api/agent/health", {
      agentId,
      status,
      timestamp: Date.now(),
      ...extra,
    });
  }

  // --- Internal HTTP helpers ---

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new Error(`Kernel GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Kernel POST ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }
}
