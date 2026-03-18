import type { NormalizedMessage } from "./domain.js";
import {
  makeTelegramChatId,
  makeTelegramMessageId,
  makeTelegramUserId,
  parseTelegramChatId
} from "./identifiers.js";
import type { Logger } from "./logging.js";
import type { ChatPresenceState, ChatTransport, SendResult } from "./transport.js";
import { sleep } from "./utils.js";

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  message_thread_id?: number;
  text?: string;
  reply_to_message?: {
    message_id: number;
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramTransportOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  pollTimeoutSeconds?: number;
  dropPendingUpdatesOnStart?: boolean;
}

function formatTelegramName(user: TelegramUser | undefined): string | null {
  if (!user) {
    return null;
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (fullName) {
    return fullName;
  }

  if (user.username?.trim()) {
    return user.username.trim();
  }

  return null;
}

function toIsoTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function parseTelegramThreadId(chatJid: string, messageThreadId: string | null): number | undefined {
  if (messageThreadId === null) {
    return undefined;
  }

  const parsed = Number(messageThreadId);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid Telegram thread id in chat id: ${chatJid}`);
  }

  return parsed;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class TelegramTransport implements ChatTransport {
  private onMessage: ((message: NormalizedMessage) => Promise<void>) | null = null;

  private started = false;

  private pollingTask: Promise<void> | null = null;

  private pollAbortController: AbortController | null = null;

  private nextUpdateOffset: number | null = null;

  private botJid = "";

  private botIdentityJids: string[] = [];

  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly retryDelayMs: number;

  private readonly pollTimeoutSeconds: number;

  private readonly dropPendingUpdatesOnStart: boolean;

  constructor(
    private readonly botToken: string,
    private readonly logger: Logger,
    options: TelegramTransportOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
    this.dropPendingUpdatesOnStart = options.dropPendingUpdatesOnStart ?? false;
  }

  async start(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<{
    botJid: string;
    botIdentityJids: string[];
  }> {
    this.onMessage = onMessage;
    if (this.started) {
      return {
        botJid: this.botJid,
        botIdentityJids: this.botIdentityJids
      };
    }

    this.started = true;
    const me = await this.callApi<TelegramUser>("getMe");
    this.botJid = makeTelegramUserId(me.id);
    this.botIdentityJids = [this.botJid];

    this.logger.info("starting telegram connection", {
      botJid: this.botJid
    });

    await this.callApi<boolean>("deleteWebhook", {
      drop_pending_updates: this.dropPendingUpdatesOnStart
    });

    this.pollingTask = this.pollLoop();
    return {
      botJid: this.botJid,
      botIdentityJids: this.botIdentityJids
    };
  }

  async sendText(chatJid: string, text: string): Promise<SendResult> {
    if (!this.started) {
      throw new Error("Telegram transport is not started.");
    }

    const target = parseTelegramChatId(chatJid);
    if (!target) {
      throw new Error(`Invalid Telegram chat id: ${chatJid}`);
    }

    const message = await this.callApi<TelegramMessage>("sendMessage", {
      chat_id: target.chatId,
      text,
      message_thread_id: parseTelegramThreadId(chatJid, target.messageThreadId)
    });

    return {
      externalId: makeTelegramMessageId(target.chatId, message.message_id),
      timestamp: toIsoTimestamp(message.date)
    };
  }

  async updatePresence(chatJid: string, state: ChatPresenceState): Promise<void> {
    if (!this.started || state === "paused") {
      return;
    }

    const target = parseTelegramChatId(chatJid);
    if (!target) {
      throw new Error(`Invalid Telegram chat id: ${chatJid}`);
    }

    await this.callApi<boolean>("sendChatAction", {
      chat_id: target.chatId,
      action: "typing",
      message_thread_id: parseTelegramThreadId(chatJid, target.messageThreadId)
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.pollAbortController?.abort();

    try {
      await this.pollingTask;
    } finally {
      this.pollAbortController = null;
      this.pollingTask = null;
      this.onMessage = null;
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.started) {
      const abortController = new AbortController();
      this.pollAbortController = abortController;

      try {
        const updates = await this.callApi<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: this.nextUpdateOffset ?? undefined,
            timeout: this.pollTimeoutSeconds,
            allowed_updates: ["message"]
          },
          abortController.signal
        );

        for (const update of updates) {
          await this.handleUpdate(update);
          this.nextUpdateOffset = update.update_id + 1;
        }
      } catch (error) {
        if (!this.started && isAbortError(error)) {
          return;
        }

        this.logger.warn("telegram polling failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        await sleep(this.retryDelayMs);
      } finally {
        if (this.pollAbortController === abortController) {
          this.pollAbortController = null;
        }
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }

    if (message.chat.type !== "private") {
      this.logger.info("ignoring telegram update outside private chats", {
        updateId: update.update_id,
        chatType: message.chat.type
      });
      return;
    }

    if (!message.from || message.from.is_bot || typeof message.text !== "string") {
      this.logger.info("ignoring unsupported telegram message", {
        updateId: update.update_id,
        hasSender: Boolean(message.from),
        senderIsBot: message.from?.is_bot ?? false,
        hasText: typeof message.text === "string"
      });
      return;
    }

    await this.onMessage?.({
      externalId: makeTelegramMessageId(message.chat.id, message.message_id),
      chatJid: makeTelegramChatId(message.chat.id, message.message_thread_id),
      chatType: "dm",
      senderJid: makeTelegramUserId(message.from.id),
      senderName: formatTelegramName(message.from),
      isFromBot: false,
      timestamp: toIsoTimestamp(message.date),
      contentType: "text",
      text: message.text,
      mentions: [],
      quotedExternalId: message.reply_to_message
        ? makeTelegramMessageId(message.chat.id, message.reply_to_message.message_id)
        : null,
      rawJson: JSON.stringify(update),
      image: null
    });
  }

  private async callApi<T>(method: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json"
      }
    };
    if (payload) {
      requestInit.body = JSON.stringify(payload);
    }
    if (signal) {
      requestInit.signal = signal;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/${method}`, requestInit);

    const raw = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !raw.ok) {
      throw new Error(raw.description ?? `Telegram API request failed for ${method}.`);
    }

    return raw.result;
  }
}
