/**
 * Cross-channel unified message formats.
 */

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; url: string; caption?: string }
  | { type: "audio"; url: string; duration?: number }
  | { type: "file"; url: string; filename: string };

export interface InboundMessage {
  id: string;
  channel: string; // "telegram", "web", "cli"
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
}

export interface OutboundMessage {
  channel: string;
  conversation: string;
  content: MessageContent;
  replyTo?: string;
}
