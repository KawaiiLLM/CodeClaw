/**
 * Cross-channel unified message formats.
 */

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; data?: string; mimeType?: string; path?: string; caption?: string }
  | { type: "audio"; url?: string; path?: string; duration?: number }
  | { type: "file"; filename: string; path?: string; size?: number; url?: string; mimeType?: string };

export interface InboundMessage {
  id: string;
  channel: string; // "telegram", "web", "cli"
  agentId?: string; // Target agent for this message (set by skill or kernel)
  sender: {
    id: string;
    name: string;
    channel: string;
  };
  conversation: {
    id: string; // Group ID / DM ID
    type: "group" | "dm";
    title?: string;
  };
  content: MessageContent;
  timestamp: number;
  replyTo?: string;
  /** Optional metadata for cross-layer communication (e.g. command routing). */
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  channel: string;
  conversation: string;
  content: MessageContent;
  replyTo?: string;
  editMessageId?: string;
  progress?: boolean;
  /** Custom Skill endpoint for non-message outbound operations (e.g. "/sticker", "/poll"). */
  skillEndpoint?: string;
  /** Endpoint-specific payload. Sent to Skill when skillEndpoint is set. */
  payload?: Record<string, unknown>;
}
