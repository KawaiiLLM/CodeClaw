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
