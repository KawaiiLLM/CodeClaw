/**
 * Skill service registration protocol.
 */

export interface SkillServiceRegistration {
  skillId: string;
  type: "channel" | "tool";
  agentId?: string; // Which agent this service belongs to
  channel?: string; // For channel-type skills: the channel name (defaults to skillId)
  capabilities: string[]; // ["send_message", "receive_message"]
  endpoint: string; // "http://localhost:7001"
}
