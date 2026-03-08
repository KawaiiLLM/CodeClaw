/**
 * Skill service registration protocol.
 */

export interface SkillServiceRegistration {
  skillId: string;
  type: "channel" | "tool";
  capabilities: string[]; // ["send_message", "receive_message"]
  endpoint: string; // "http://localhost:7001"
}
