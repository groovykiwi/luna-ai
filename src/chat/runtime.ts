import type { Logger } from "../logging.js";
import type { RuntimeContext } from "../domain.js";
import type { TinyClawDb } from "../db.js";
import type { LanguageGateway } from "../llm.js";
import type { ChatTransport } from "../transport.js";
import { persistInboundImage } from "../media.js";
import { MemoryService } from "../memory.js";
import { ReplyService, splitReplyIntoBubbles } from "../reply.js";
import { randomIntInclusive, sleep } from "../utils.js";
import { detectTrigger } from "./trigger.js";
import { TurnQueue } from "./queue.js";

export class ChatRuntime {
  private static readonly typingRefreshMs = 8_000;

  private readonly memoryService: MemoryService;

  private readonly replyService: ReplyService;

  private readonly queue: TurnQueue;

  private botJid = "";

  private botIdentityJids: string[] = [];

  constructor(
    private readonly runtimeContext: RuntimeContext,
    private readonly db: TinyClawDb,
    private readonly transport: ChatTransport,
    private readonly gateway: LanguageGateway,
    private readonly logger: Logger
  ) {
    this.memoryService = new MemoryService(db, gateway, runtimeContext.botConfig.retrievalMinHits);
    this.replyService = new ReplyService(db, gateway, this.memoryService, runtimeContext);
    this.queue = new TurnQueue(async (chatId) => this.processTurn(chatId));
  }

  async start(): Promise<void> {
    const { botJid, botIdentityJids } = await this.transport.start(async (message) => {
      await this.handleInboundMessage(message);
    });

    this.botJid = botJid;
    this.botIdentityJids = botIdentityJids;
    this.logger.info("chat process ready", {
      botJid,
      botIdentityJids,
      botId: this.runtimeContext.botConfig.botId
    });

    for (const chatId of this.db.listChatsWithPendingTurns()) {
      this.queue.enqueue(chatId);
    }
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }

  private isReplyAllowed(chatJid: string, chatType: "dm" | "group"): boolean {
    const allowlist =
      chatType === "dm"
        ? this.runtimeContext.botConfig.replyWhitelist.dms
        : this.runtimeContext.botConfig.replyWhitelist.groups;

    if (allowlist === null) {
      return true;
    }

    return allowlist.includes(chatJid);
  }

  private async handleInboundMessage(message: import("../domain.js").NormalizedMessage): Promise<void> {
    const existingChat = this.db.findChatByJid(message.chatJid);
    const quoted = existingChat ? this.db.findQuotedMessage(existingChat.id, message.quotedExternalId) : null;
    const replyAllowed = this.isReplyAllowed(message.chatJid, message.chatType);
    const trigger = detectTrigger({
      chatType: message.chatType,
      isFromBot: message.isFromBot,
      text: message.text,
      mentions: message.mentions,
      botJids: this.botIdentityJids.length > 0 ? this.botIdentityJids : [this.botJid],
      triggerNames: this.runtimeContext.botConfig.triggerNames,
      isDirectReplyToBot: quoted?.isFromBot ?? false
    });

    let mediaFilePath: string | null = null;
    let imageDescription: string | null = null;
    if (message.image) {
      mediaFilePath = persistInboundImage(
        this.runtimeContext.paths.mediaDir,
        message.externalId,
        message.image.mimeType,
        message.image.buffer
      );
      try {
        imageDescription = await this.gateway.describeImage({
          buffer: message.image.buffer,
          mimeType: message.image.mimeType,
          caption: message.image.caption
        });
      } catch (error) {
        this.logger.warn("vision description failed", {
          externalId: message.externalId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const contextOnly = !replyAllowed || (message.chatType === "group" && !trigger.triggered);
    const result = this.db.ingestMessage(
      {
        chatJid: message.chatJid,
        chatType: message.chatType,
        senderJid: message.senderJid,
        senderName: message.senderName,
        externalId: message.externalId,
        contentType: message.contentType,
        text: message.text,
        imageDescription,
        quotedExternalId: message.quotedExternalId,
        mentions: message.mentions,
        rawJson: message.rawJson,
        createdAt: message.timestamp,
        isFromBot: false,
        mediaFilePath,
        mediaMimeType: message.image?.mimeType ?? null
      },
      {
        contextOnly,
        // Chats outside the reply allowlist stay archived, but do not affect long-term memory.
        memoryEligible: replyAllowed && !contextOnly,
        wasTriggered: trigger.triggered,
        turnEligible: replyAllowed && trigger.triggered
      },
      this.runtimeContext.botConfig.blockSize
    );

    this.logger.info("ingested message", {
      chatId: result.chatId,
      messageId: result.messageId,
      replyAllowed,
      triggered: trigger.triggered,
      reason: trigger.reason,
      blockClosed: result.blockClosed
    });

    if (replyAllowed && trigger.triggered) {
      this.queue.enqueue(result.chatId);
    }
  }

  private async processTurn(chatId: number): Promise<boolean> {
    const turnStartedAt = Date.now();
    const pendingMessages = this.db.getPendingTurnMessages(chatId);
    if (pendingMessages.length === 0) {
      return false;
    }

    const chat = this.db.getChatById(chatId);
    if (!chat) {
      return false;
    }

    if (!this.isReplyAllowed(chat.jid, chat.type)) {
      this.logger.info("skipping pending turn for non-allowlisted chat", {
        chatId,
        chatJid: chat.jid,
        chatType: chat.type
      });
      this.db.markTurnMessagesProcessed(
        pendingMessages.map((message) => message.id),
        new Date().toISOString()
      );
      return this.db.getPendingTurnMessages(chatId).length > 0;
    }

    return this.runWithTypingPresence(chat.jid, async () => {
      const generationStartedAt = Date.now();
      const generated = await this.replyService.generateForTurn(chatId, pendingMessages);
      const generationMs = Date.now() - generationStartedAt;
      const bubbles = splitReplyIntoBubbles(generated.reply);
      if (bubbles.length === 0) {
        this.db.markTurnMessagesProcessed(
          pendingMessages.map((message) => message.id),
          generated.memoryAppliedAt
        );
        this.logger.info("completed turn without outbound bubbles", {
          chatId,
          pendingMessageCount: pendingMessages.length,
          generationMs,
          totalMs: Date.now() - turnStartedAt
        });
        return this.db.getPendingTurnMessages(chatId).length > 0;
      }

      const sendStartedAt = Date.now();
      for (let index = 0; index < bubbles.length; index += 1) {
        const bubble = bubbles[index];
        if (!bubble) {
          continue;
        }

        const sent = await this.transport.sendText(chat.jid, bubble);
        this.db.createBotMessage(
          chat.jid,
          chat.type,
          this.botJid,
          sent.externalId,
          bubble,
          sent.timestamp,
          this.runtimeContext.botConfig.blockSize
        );

        const isLastBubble = index === bubbles.length - 1;
        if (!isLastBubble) {
          const [minDelay, maxDelay] = this.runtimeContext.botConfig.bubbleDelayMs;
          await sleep(randomIntInclusive(minDelay, maxDelay));
        }
      }

      this.db.markTurnMessagesProcessed(
        pendingMessages.map((message) => message.id),
        new Date().toISOString()
      );

      this.logger.info("completed turn", {
        chatId,
        pendingMessageCount: pendingMessages.length,
        bubbleCount: bubbles.length,
        generationMs,
        sendMs: Date.now() - sendStartedAt,
        totalMs: Date.now() - turnStartedAt
      });

      return this.db.getPendingTurnMessages(chatId).length > 0;
    });
  }

  private async runWithTypingPresence<T>(chatJid: string, action: () => Promise<T>): Promise<T> {
    await this.updateTypingPresence(chatJid, "composing");
    const interval = setInterval(() => {
      void this.updateTypingPresence(chatJid, "composing");
    }, ChatRuntime.typingRefreshMs);

    try {
      return await action();
    } finally {
      clearInterval(interval);
      await this.updateTypingPresence(chatJid, "paused");
    }
  }

  private async updateTypingPresence(chatJid: string, state: "composing" | "paused"): Promise<void> {
    try {
      await this.transport.updatePresence(chatJid, state);
    } catch (error) {
      this.logger.warn("typing presence update failed", {
        chatJid,
        state,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
