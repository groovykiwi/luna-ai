import * as Baileys from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

import type { NormalizedMessage } from "./domain.js";
import type { Logger } from "./logging.js";
import type { ChatPresenceState, ChatTransport, SendResult } from "./transport.js";

const RECOVERABLE_EMPTY_STUB_PARAMETERS = new Set([
  Baileys.NO_MESSAGE_FOUND_ERROR_TEXT,
  Baileys.MISSING_KEYS_ERROR_TEXT
]);

export function writeWhatsAppQr(qr: string, stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  stdout.write(
    "\nWhatsApp login required.\nOpen WhatsApp on your phone, then go to Linked Devices > Link a Device and scan this QR:\n\n"
  );
  qrcode.generate(qr, { small: true }, (rendered) => {
    stdout.write(`${rendered}\n`);
  });
  stdout.write("\n");
}

function normalizeJid(value: string): string {
  const [localPart, domain] = value.split("@");
  if (!localPart || !domain) {
    return value;
  }

  const bareLocalPart = localPart.split(":")[0];
  return `${bareLocalPart}@${domain}`;
}

function getTimestampSeconds(rawTimestamp: unknown): number {
  if (typeof rawTimestamp === "number") {
    return rawTimestamp;
  }

  if (typeof rawTimestamp === "string") {
    const parsed = Number(rawTimestamp);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (typeof rawTimestamp === "bigint") {
    return Number(rawTimestamp);
  }

  if (rawTimestamp && typeof rawTimestamp === "object") {
    if ("low" in rawTimestamp && typeof (rawTimestamp as { low?: unknown }).low === "number") {
      return (rawTimestamp as { low: number }).low;
    }
    if ("toNumber" in rawTimestamp && typeof (rawTimestamp as { toNumber?: unknown }).toNumber === "function") {
      return Number((rawTimestamp as { toNumber: () => number }).toNumber());
    }
  }

  return Math.floor(Date.now() / 1000);
}

export function shouldProcessUpsertType(upsertType: string | null | undefined): boolean {
  // `append` can carry newly delivered messages on reconnecting multi-device clients.
  return upsertType === "notify" || upsertType === "append";
}

function extractIncomingContent(message: Record<string, any> | null | undefined): Record<string, any> | null {
  const extracted =
    (Baileys.extractMessageContent(message as any) ?? Baileys.normalizeMessageContent(message as any)) ?? null;
  return extracted && typeof extracted === "object" ? (extracted as Record<string, any>) : null;
}

function getStubParameters(rawMessage: any): string[] {
  if (!Array.isArray(rawMessage?.messageStubParameters)) {
    return [];
  }

  return rawMessage.messageStubParameters.filter((value: unknown): value is string => typeof value === "string");
}

export function shouldRequestPlaceholderResend(rawMessage: any, requestId?: string | null): boolean {
  if (requestId || !rawMessage?.key?.id || rawMessage?.key?.fromMe) {
    return false;
  }

  const hasMessageContent =
    rawMessage?.message && typeof rawMessage.message === "object" && Object.keys(rawMessage.message).length > 0;
  if (hasMessageContent) {
    return false;
  }

  const stubParameters = getStubParameters(rawMessage);
  if (stubParameters.some((value) => RECOVERABLE_EMPTY_STUB_PARAMETERS.has(value))) {
    return true;
  }

  return Number(rawMessage?.messageStubType ?? 0) === Baileys.WAMessageStubType.CIPHERTEXT;
}

export function shouldIgnoreInboundProtocolMessage(rawMessage: any, content: Record<string, any> | null): boolean {
  if (!content) {
    return false;
  }

  if (rawMessage?.category === "peer") {
    return true;
  }

  return Boolean(content.protocolMessage);
}

function extractText(content: Record<string, any>): string | null {
  if (typeof content.conversation === "string") {
    return content.conversation;
  }

  if (typeof content.extendedTextMessage?.text === "string") {
    return content.extendedTextMessage.text;
  }

  if (typeof content.imageMessage?.caption === "string") {
    return content.imageMessage.caption;
  }

  return null;
}

function extractContextInfo(content: Record<string, any>): Record<string, any> | null {
  return (
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.conversation?.contextInfo ??
    null
  );
}

export class BaileysTransport implements ChatTransport {
  private socket: any = null;

  private onMessage: ((message: NormalizedMessage) => Promise<void>) | null = null;

  private botJid = "";

  private botIdentityJids: string[] = [];

  private resumeCutoffSeconds = Math.floor(Date.now() / 1000);

  private started = false;

  private readonly pendingPlaceholderResends = new Set<string>();

  private readonly baileysLogger = {
    level: "silent",
    child() {
      return this;
    },
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {}
  };

  private readonly mediaContext = {
    logger: this.baileysLogger,
    reuploadRequest: async (message: any) => this.socket.updateMediaMessage(message)
  };

  constructor(private readonly authDir: string, private readonly logger: Logger) {}

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
    this.logger.info("starting whatsapp connection", {
      authDir: this.authDir
    });
    await this.connect(true);
    return {
      botJid: this.botJid,
      botIdentityJids: this.botIdentityJids
    };
  }

  async sendText(chatJid: string, text: string): Promise<SendResult> {
    if (!this.socket) {
      throw new Error("Baileys socket is not connected.");
    }

    const result = await this.socket.sendMessage(chatJid, { text });
    return {
      externalId: result?.key?.id ?? `out-${Date.now()}`,
      timestamp: new Date().toISOString()
    };
  }

  async updatePresence(chatJid: string, state: ChatPresenceState): Promise<void> {
    if (!this.socket) {
      throw new Error("Baileys socket is not connected.");
    }

    await this.socket.sendPresenceUpdate(state, chatJid);
  }

  async stop(): Promise<void> {
    try {
      this.socket?.end?.(undefined);
    } finally {
      this.socket = null;
      this.started = false;
    }
  }

  private async connect(waitForOpen: boolean): Promise<void> {
    const { state, saveCreds } = await Baileys.useMultiFileAuthState(this.authDir);
    const versionInfo = await Baileys.fetchLatestBaileysVersion();
    const socketFactory = (Baileys.makeWASocket ?? (Baileys as { default?: unknown }).default) as (
      config: Record<string, unknown>
    ) => any;

    let resolveOpen: (() => void) | null = null;
    const openPromise = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });

    this.socket = socketFactory({
      auth: {
        creds: state.creds,
        // Baileys expects a cacheable signal key store for reliable decryption on live sessions.
        keys: Baileys.makeCacheableSignalKeyStore(state.keys, this.baileysLogger as any)
      },
      version: versionInfo.version,
      // Render QR ourselves so the operator gets explicit instructions in plain terminal output.
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      logger: this.baileysLogger
    } as any);

    this.socket.ev.on("creds.update", saveCreds);
    this.socket.ev.on("connection.update", async (update: any) => {
      if (update.connection) {
        this.logger.info("whatsapp connection update", {
          state: update.connection
        });
      }

      if (typeof update.qr === "string" && update.qr.trim()) {
        writeWhatsAppQr(update.qr, process.stdout);
        this.logger.info("whatsapp qr ready");
      }

      if (update.connection === "open") {
        this.botJid = normalizeJid(this.socket.user?.id ?? "");
        this.botIdentityJids = [
          normalizeJid(this.socket.user?.id ?? ""),
          normalizeJid(this.socket.user?.lid ?? "")
        ].filter(Boolean);
        this.resumeCutoffSeconds = Math.floor(Date.now() / 1000);
        this.logger.info("whatsapp connection open", {
          botJid: this.botJid,
          botIdentityJids: this.botIdentityJids
        });
        resolveOpen?.();
        resolveOpen = null;
      }

      if (update.connection === "close") {
        const statusCode = Number(update.lastDisconnect?.error?.output?.statusCode ?? 0);
        const shouldReconnect = statusCode !== Baileys.DisconnectReason.loggedOut;
        this.logger.warn("whatsapp connection closed", {
          statusCode,
          shouldReconnect
        });

        if (shouldReconnect) {
          try {
            await this.connect(false);
          } catch (error) {
            this.logger.error("whatsapp reconnect failed", {
              statusCode,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    });

    this.socket.ev.on("messages.upsert", async (event: any) => {
      this.logger.info("messages.upsert received", {
        type: event?.type ?? null,
        count: Array.isArray(event?.messages) ? event.messages.length : 0
      });

      if (!shouldProcessUpsertType(event?.type) || !this.onMessage) {
        return;
      }

      for (const rawMessage of event.messages ?? []) {
        try {
          const normalized = await this.normalizeIncomingMessage(rawMessage, {
            requestId: typeof event?.requestId === "string" ? event.requestId : null
          });
          if (!normalized) {
            continue;
          }

          await this.onMessage(normalized);
        } catch (error) {
          this.logger.error("failed to handle whatsapp inbound message", {
            remoteJid: rawMessage?.key?.remoteJid ?? null,
            externalId: rawMessage?.key?.id ?? null,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    if (waitForOpen) {
      await openPromise;
    }
  }

  private async normalizeIncomingMessage(
    rawMessage: any,
    options: {
      requestId: string | null;
    }
  ): Promise<NormalizedMessage | null> {
    if (!rawMessage?.key?.remoteJid || rawMessage.key.fromMe) {
      this.logger.info("dropping inbound candidate before normalization", {
        reason: !rawMessage?.key?.remoteJid ? "missing_remote_jid" : "from_me",
        key: rawMessage?.key ?? null
      });
      return null;
    }

    const timestampSeconds = getTimestampSeconds(rawMessage.messageTimestamp);
    if (timestampSeconds < this.resumeCutoffSeconds) {
      this.logger.info("dropping inbound candidate as stale", {
        remoteJid: rawMessage.key.remoteJid,
        timestampSeconds,
        resumeCutoffSeconds: this.resumeCutoffSeconds
      });
      return null;
    }

    const messageKeyId = typeof rawMessage.key.id === "string" ? rawMessage.key.id : null;
    const content = extractIncomingContent(rawMessage.message);
    if (!content) {
      const stubParameters = getStubParameters(rawMessage);
      const requestId = options.requestId;
      const shouldRetry = shouldRequestPlaceholderResend(rawMessage, requestId);
      if (shouldRetry && messageKeyId && !this.pendingPlaceholderResends.has(messageKeyId)) {
        this.pendingPlaceholderResends.add(messageKeyId);
        try {
          await this.socket?.requestPlaceholderResend?.(rawMessage.key);
          this.logger.warn("requested placeholder resend for empty inbound message", {
            remoteJid: rawMessage.key.remoteJid,
            externalId: messageKeyId,
            requestId,
            stubType: rawMessage.messageStubType ?? null,
            stubParameters
          });
        } catch (error) {
          this.pendingPlaceholderResends.delete(messageKeyId);
          this.logger.warn("placeholder resend request failed", {
            remoteJid: rawMessage.key.remoteJid,
            externalId: messageKeyId,
            requestId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      this.logger.info("dropping inbound candidate with empty content", {
        remoteJid: rawMessage.key.remoteJid,
        externalId: messageKeyId,
        requestId,
        messageKeys: rawMessage.message ? Object.keys(rawMessage.message) : [],
        stubType: rawMessage.messageStubType ?? null,
        stubParameters
      });
      return null;
    }

    if (shouldIgnoreInboundProtocolMessage(rawMessage, content)) {
      this.logger.info("dropping inbound protocol message", {
        remoteJid: rawMessage.key.remoteJid,
        externalId: messageKeyId,
        category: rawMessage.category ?? null,
        protocolType: content.protocolMessage?.type ?? null
      });
      return null;
    }

    if (messageKeyId) {
      this.pendingPlaceholderResends.delete(messageKeyId);
    }

    const chatJid = normalizeJid(rawMessage.key.remoteJid);
    const chatType = chatJid.endsWith("@g.us") ? "group" : "dm";
    const senderJid = normalizeJid(rawMessage.key.participant ?? rawMessage.key.remoteJid);
    const contextInfo = extractContextInfo(content);
    const mentions = Array.isArray(contextInfo?.mentionedJid)
      ? contextInfo.mentionedJid.map((jid: string) => normalizeJid(jid))
      : [];
    const quotedExternalId = typeof contextInfo?.stanzaId === "string" ? contextInfo.stanzaId : null;
    const text = extractText(content);

    let image: NormalizedMessage["image"] = null;
    let contentType: NormalizedMessage["contentType"] = "text";
    if (content.imageMessage) {
      const buffer = (await Baileys.downloadMediaMessage(
        rawMessage,
        "buffer",
        {},
        this.mediaContext as any
      )) as Buffer;
      image = {
        buffer,
        mimeType: content.imageMessage.mimetype ?? "application/octet-stream",
        caption: content.imageMessage.caption ?? null
      };
      contentType = "image";
    }

    return {
      externalId: rawMessage.key.id ?? `in-${Date.now()}`,
      chatJid,
      chatType,
      senderJid,
      senderName: rawMessage.pushName ?? null,
      isFromBot: false,
      timestamp: new Date(timestampSeconds * 1000).toISOString(),
      contentType,
      text,
      mentions,
      quotedExternalId,
      rawJson: JSON.stringify(rawMessage),
      image
    };
  }
}
