import { areJidsSameUser } from "@whiskeysockets/baileys";

import type { BotProvider } from "./domain.js";

interface ParsedTelegramChatId {
  chatId: string;
  messageThreadId: string | null;
}

export function normalizeWhatsAppJid(value: string): string {
  const trimmed = value.trim();
  const [localPart, domain] = trimmed.split("@");
  if (!localPart || !domain) {
    return trimmed;
  }

  return `${localPart.split(":")[0]}@${domain}`;
}

export function normalizeIdentifier(provider: BotProvider, value: string): string {
  if (provider === "telegram") {
    return value.trim();
  }

  return normalizeWhatsAppJid(value);
}

export function isTelegramIdentifier(value: string): boolean {
  return value.startsWith("tg:");
}

export function areUserIdentifiersSame(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  if (isTelegramIdentifier(left) || isTelegramIdentifier(right)) {
    return false;
  }

  return areJidsSameUser(left, right);
}

export function makeTelegramChatId(
  chatId: number | string | bigint,
  messageThreadId?: number | string | bigint | null
): string {
  const baseChatId = `tg:chat:${String(chatId)}`;
  if (messageThreadId === undefined || messageThreadId === null) {
    return baseChatId;
  }

  return `${baseChatId}:thread:${String(messageThreadId)}`;
}

export function makeTelegramUserId(userId: number | string | bigint): string {
  return `tg:user:${String(userId)}`;
}

export function makeTelegramMessageId(chatId: number | string | bigint, messageId: number | string | bigint): string {
  return `tg:msg:${String(chatId)}:${String(messageId)}`;
}

export function parseTelegramChatId(value: string): ParsedTelegramChatId | null {
  const match = /^tg:chat:([^:]+)(?::thread:([^:]+))?$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const [, chatId, messageThreadId] = match;
  if (!chatId) {
    return null;
  }

  return {
    chatId,
    messageThreadId: messageThreadId ?? null
  };
}

export function isTelegramChatIdentifierMatch(configuredValue: string, actualValue: string): boolean {
  if (configuredValue === actualValue) {
    return true;
  }

  const configured = parseTelegramChatId(configuredValue);
  const actual = parseTelegramChatId(actualValue);
  if (!configured || !actual) {
    return false;
  }

  if (configured.chatId !== actual.chatId) {
    return false;
  }

  if (configured.messageThreadId === null) {
    return true;
  }

  return configured.messageThreadId === actual.messageThreadId;
}
