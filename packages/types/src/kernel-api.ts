/**
 * Kernel API interface exposed to the agent container.
 */

import type { InboundMessage, OutboundMessage } from "./messages.js";
import type { SkillServiceRegistration } from "./skill-service.js";

export interface KernelAPI {
  // Messages
  getNextMessage(): Promise<InboundMessage | null>;
  sendMessage(msg: OutboundMessage): Promise<void>;
  getQueueStatus(): Promise<{ pending: number; channels: string[] }>;
  // Skill services
  registerSkillService(reg: SkillServiceRegistration): Promise<void>;
  unregisterSkillService(skillId: string): Promise<void>;
  // Lifecycle
  reportHealth(status: "alive" | "busy" | "idle"): Promise<void>;
}

export interface QueueStatus {
  pending: number;
  channels: string[];
  byChannel: Record<string, number>;
}

export interface AgentHealthReport {
  agentId: string;
  status: "alive" | "busy" | "idle";
  timestamp: number;
  sessionId?: string;
  lastAssistantMessageId?: string;
  conversation?: string;
}

export interface KernelStatus {
  uptime: number;
  agents: Record<string, { status: string; health?: string }>;
  services: Record<string, SkillServiceRegistration>;
  queue: QueueStatus;
}
