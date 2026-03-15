import type {
  InboundMessage,
  OutboundMessage,
  SkillServiceRegistration,
} from "@codeclaw/types";
import { MessageQueue } from "./message-queue.js";
import { logger } from "./logger.js";

export class IOBridge {
  // Composite key "agentId:skillId" (or ":skillId" for untagged) → registration
  private services = new Map<string, SkillServiceRegistration>();
  // Index: "agentId:channel" → service key (with fallback to ":channel" for untagged)
  private channelIndex = new Map<string, string>();

  constructor(private messageQueue: MessageQueue) {}

  private serviceKey(reg: SkillServiceRegistration): string {
    return reg.agentId ? `${reg.agentId}:${reg.skillId}` : `:${reg.skillId}`;
  }

  /** Register a skill service. Channel-type skills are indexed by agentId + channel. */
  registerService(reg: SkillServiceRegistration): void {
    const svcKey = this.serviceKey(reg);
    this.services.set(svcKey, reg);
    if (reg.type === "channel") {
      const channelName = reg.channel ?? reg.skillId;
      const chKey = reg.agentId ? `${reg.agentId}:${channelName}` : `:${channelName}`;
      this.channelIndex.set(chKey, svcKey);
    }
    logger.info(
      { skillId: reg.skillId, type: reg.type, agentId: reg.agentId, channel: reg.channel, endpoint: reg.endpoint },
      "Skill service registered",
    );
  }

  /** Unregister a skill service. */
  unregisterService(skillId: string, agentId?: string): void {
    const svcKey = agentId ? `${agentId}:${skillId}` : `:${skillId}`;
    const reg = this.services.get(svcKey);
    if (reg) {
      if (reg.type === "channel") {
        const channelName = reg.channel ?? reg.skillId;
        const chKey = reg.agentId ? `${reg.agentId}:${channelName}` : `:${channelName}`;
        this.channelIndex.delete(chKey);
      }
      this.services.delete(svcKey);
      logger.info({ skillId, agentId }, "Skill service unregistered");
    }
  }

  /** Look up the skill service for a given channel, optionally scoped to an agent. */
  getServiceForChannel(channel: string, agentId?: string): SkillServiceRegistration | null {
    // Try agent-specific first
    if (agentId) {
      const svcKey = this.channelIndex.get(`${agentId}:${channel}`);
      if (svcKey) return this.services.get(svcKey) ?? null;
    }
    // Fallback: untagged (single-agent compat)
    const svcKey = this.channelIndex.get(`:${channel}`);
    if (svcKey) return this.services.get(svcKey) ?? null;
    // Legacy fallback: try skillId directly (untagged key)
    return this.services.get(`:${channel}`) ?? null;
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
  async routeOutbound(msg: OutboundMessage): Promise<Record<string, unknown>> {
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

    // Standard message routing: transparent pass-through to Skill /send
    const url = `${service.endpoint}/send`;
    logger.debug({ channel: msg.channel, conversation: msg.conversation, endpoint: url }, "Routing outbound message");
    const payload = msg;

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
