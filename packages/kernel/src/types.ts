/** Kernel-internal types (not shared across packages). */

export interface HttpJsonBody {
  [key: string]: unknown;
}

export interface AgentInfo {
  id: string;
  containerId?: string;
  status: "creating" | "running" | "stopped" | "error";
  health?: "alive" | "busy" | "idle" | "unknown";
  startedAt?: number;
}
