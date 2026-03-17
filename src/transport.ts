import type { NormalizedMessage } from "./domain.js";

export interface SendResult {
  externalId: string;
  timestamp: string;
}

export type ChatPresenceState = "composing" | "paused";

export interface ChatTransport {
  start(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<{
    botJid: string;
    botIdentityJids: string[];
  }>;
  sendText(chatJid: string, text: string): Promise<SendResult>;
  updatePresence(chatJid: string, state: ChatPresenceState): Promise<void>;
  stop(): Promise<void>;
}
