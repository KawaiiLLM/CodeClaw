import type {
  InboundMessage,
  OutboundMessage,
  SkillServiceRegistration,
} from "@codeclaw/types";
import { MessageQueue } from "./message-queue.js";
import { logger } from "./logger.js";

export class IOBridge {
  private services = new Map<string, SkillServiceRegistration>();
  private channelIndex = new Map<string, string>(); // channel -> skillId

  constructor(private messageQueue: MessageQueue) {}

  /** Register a skill service. Channel-type skills are indexed by channel name. */
  registerService(reg: SkillServiceRegistration): void {
    this.services.set(reg.skillId, reg);
    if (reg.type === "channel") {
      this.channelIndex.set(reg.skillId, reg.skillId);
    }
    logger.info({ skillId: reg.skillId, type: reg.type, endpoint: reg.endpoint }, "Skill service registered");
  }

  /** Unregister a skill service. */
  unregisterService(skillId: string): void {
    const reg = this.services.get(skillId);
    if (reg) {
      if (reg.type === "channel") {
        this.channelIndex.delete(reg.skillId);
      }
      this.services.delete(skillId);
      logger.info({ skillId }, "Skill service unregistered");
    }
  }

  /** Look up the skill service for a given channel. */
  getServiceForChannel(channel: string): SkillServiceRegistration | null {
    const skillId = this.channelIndex.get(channel) ?? channel;
    return this.services.get(skillId) ?? null;
  }

  /** Get all registered services. */
  getAllServices(): Record<string, SkillServiceRegistration> {
    return Object.fromEntries(this.services);
  }

  /** Handle an inbound message from a skill service → push to message queue. */
  handleInbound(msg: InboundMessage): boolean {
    const enqueued = this.messageQueue.enqueue(msg);
    if (enqueued) {
      logger.debug({ channel: msg.channel, msgId: msg.id, sender: msg.sender.name }, "Inbound message enqueued");
    } else {
      logger.debug({ channel: msg.channel, msgId: msg.id }, "Inbound message deduplicated");
    }
    return enqueued;
  }

  /** Route an outbound message to the appropriate skill service. */
  async routeOutbound(msg: OutboundMessage): Promise<void> {
    const service = this.getServiceForChannel(msg.channel);
    if (!service) {
      throw new Error(`No skill service registered for channel: ${msg.channel}`);
    }

    const url = `${service.endpoint}/send`;
    logger.debug({ channel: msg.channel, conversation: msg.conversation, endpoint: url }, "Routing outbound message");

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Skill service ${service.skillId} returned ${res.status}: ${body}`);
    }
  }
}
