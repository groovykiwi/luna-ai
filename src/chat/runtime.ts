import type { ChatType } from "../domain.js";
import type { Logger } from "../logging.js";
import type { RuntimeContext } from "../domain.js";
import type { LunaDb } from "../db.js";
import { HeartbeatService } from "../heartbeat.js";
import { isTelegramChatIdentifierMatch } from "../identifiers.js";
import type { LanguageGateway } from "../llm.js";
import type { ChatTransport } from "../transport.js";
import { persistInboundImage } from "../media.js";
import { MemoryService } from "../memory.js";
import { prepareReplyBubbles, ReplyService } from "../reply.js";
import { randomIntInclusive, sleep } from "../utils.js";
import { detectTrigger } from "./trigger.js";
import { TurnQueue } from "./queue.js";

export class ChatRuntime {
  private static readonly typingRefreshMs = 8_000;

  private static readonly turnRetryInitialMs = 500;

  private static readonly turnRetryMaxMs = 30_000;

  private readonly memoryService: MemoryService;

  private readonly replyService: ReplyService;

  private readonly heartbeatService: HeartbeatService;

  private readonly queue: TurnQueue;

  private botJid = "";

  private botIdentityJids: string[] = [];

  private heartbeatTimer: NodeJS.Timeout | null = null;

  private readonly turnRetryTimers = new Map<number, NodeJS.Timeout>();

  private readonly turnRetryDelayMs = new Map<number, number>();

  private heartbeatRunning = false;

  private stopping = false;

  constructor(
    private readonly runtimeContext: RuntimeContext,
    private readonly db: LunaDb,
    private readonly transport: ChatTransport,
    private readonly gateway: LanguageGateway,
    private readonly logger: Logger
  ) {
    this.memoryService = new MemoryService(db, gateway, runtimeContext.botConfig.retrievalMinHits);
    this.replyService = new ReplyService(db, gateway, this.memoryService, runtimeContext);
    this.heartbeatService = new HeartbeatService(db, gateway, this.memoryService, runtimeContext);
    this.queue = new TurnQueue(
      async (chatId) => this.processTurn(chatId),
      (chatId, error) => {
        this.logger.error("turn queue handler failed", {
          chatId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    );
  }

  async start(): Promise<void> {
    const { botJid, botIdentityJids } = await this.transport.start(async (message) => {
      try {
        await this.handleInboundMessage(message);
      } catch (error) {
        this.logger.error("failed to process inbound message", {
          externalId: message.externalId,
          chatJid: message.chatJid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    this.botJid = botJid;
    this.botIdentityJids = botIdentityJids;
    this.logger.info("chat process ready", {
      botJid,
      botIdentityJids,
      botId: this.runtimeContext.botConfig.botId
    });

    const staleTurnLocks = this.db.releaseStaleTurnLocks(
      new Date(Date.now() - this.runtimeContext.rootConfig.staleJobAfterMs).toISOString()
    );
    if (staleTurnLocks > 0) {
      this.logger.warn("released stale turn locks", {
        count: staleTurnLocks
      });
    }

    for (const chatId of this.db.listChatsWithPendingTurns()) {
      this.queue.enqueue(chatId);
    }

    this.scheduleNextHeartbeat();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const timer of this.turnRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.turnRetryTimers.clear();
    this.turnRetryDelayMs.clear();
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

    if (this.runtimeContext.botConfig.provider === "telegram") {
      return allowlist.some((allowedChatJid) => isTelegramChatIdentifierMatch(allowedChatJid, chatJid));
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
    let mediaErrorMessage: string | null = null;
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
        mediaErrorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn("vision description failed", {
          externalId: message.externalId,
          error: mediaErrorMessage
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
        mediaMimeType: message.image?.mimeType ?? null,
        mediaErrorMessage
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

    if (!replyAllowed) {
      this.db.markChatReviewedThrough(result.chatId, result.messageId, message.timestamp);
    }

    if (replyAllowed && trigger.triggered) {
      this.queue.enqueue(result.chatId);
    }
  }

  private async processTurn(chatId: number): Promise<boolean> {
    this.clearTurnRetry(chatId);
    let pendingMessages: ReturnType<LunaDb["getPendingTurnMessages"]> = [];

    try {
      const turnStartedAt = Date.now();
      pendingMessages = this.db.claimPendingTurnMessages(chatId, new Date().toISOString());
      if (pendingMessages.length === 0) {
        this.turnRetryDelayMs.delete(chatId);
        return false;
      }

      const chat = this.db.getChatById(chatId);
      if (!chat) {
        this.db.unlockTurnMessages(pendingMessages.map((message) => message.id));
        this.turnRetryDelayMs.delete(chatId);
        return false;
      }

      if (!this.isReplyAllowed(chat.jid, chat.type)) {
        const reviewedAt = new Date().toISOString();
        this.logger.info("skipping pending turn for non-allowlisted chat", {
          chatId,
          chatJid: chat.jid,
          chatType: chat.type
        });
        this.db.markTurnMessagesProcessed(
          pendingMessages.map((message) => message.id),
          reviewedAt
        );
        const lastPendingMessage = pendingMessages[pendingMessages.length - 1];
        if (lastPendingMessage) {
          this.db.markChatReviewedThrough(chatId, lastPendingMessage.id, reviewedAt);
        }
        this.turnRetryDelayMs.delete(chatId);
        return this.db.getPendingTurnMessages(chatId).length > 0;
      }

      const hasMore = await this.runWithTypingPresence(chat.jid, async () => {
        const generationStartedAt = Date.now();
        const generated = await this.replyService.generateForTurn(chatId, pendingMessages);
        const generationMs = Date.now() - generationStartedAt;
        const lastPendingMessage = pendingMessages[pendingMessages.length - 1];
        const bubbles = prepareReplyBubbles(generated.reply, {
          botId: this.runtimeContext.botConfig.botId,
          messagePrefix: this.runtimeContext.botConfig.messagePrefix
        });
        if (bubbles.length === 0) {
          this.db.markTurnMessagesProcessed(
            pendingMessages.map((message) => message.id),
            generated.memoryAppliedAt
          );
          if (lastPendingMessage) {
            this.db.markChatReviewedThrough(chatId, lastPendingMessage.id, generated.memoryAppliedAt);
          }
          this.logger.info("completed turn without outbound bubbles", {
            chatId,
            pendingMessageCount: pendingMessages.length,
            generationMs,
            totalMs: Date.now() - turnStartedAt
          });
          return this.db.getPendingTurnMessages(chatId).length > 0;
        }

        const sent = await this.sendReply(chat.jid, chat.type, bubbles);
        const completedAt = new Date().toISOString();

        this.db.markTurnMessagesProcessed(
          pendingMessages.map((message) => message.id),
          completedAt
        );
        if (lastPendingMessage) {
          this.db.markChatReviewedThrough(chatId, lastPendingMessage.id, completedAt);
        }

        this.logger.info("completed turn", {
          chatId,
          pendingMessageCount: pendingMessages.length,
          bubbleCount: sent.bubbleCount,
          generationMs,
          sendMs: sent.sendMs,
          totalMs: Date.now() - turnStartedAt
        });

        return this.db.getPendingTurnMessages(chatId).length > 0;
      });

      this.turnRetryDelayMs.delete(chatId);
      return hasMore;
    } catch (error) {
      this.db.unlockTurnMessages(pendingMessages.map((message) => message.id));
      const pendingCount = this.db.getPendingTurnMessages(chatId).length;
      this.logger.error("turn failed", {
        chatId,
        pendingMessageCount: pendingCount,
        error: error instanceof Error ? error.message : String(error)
      });

      if (pendingCount > 0) {
        this.scheduleTurnRetry(chatId);
      } else {
        this.turnRetryDelayMs.delete(chatId);
      }

      return false;
    }
  }

  private scheduleNextHeartbeat(): void {
    if (this.stopping || !this.runtimeContext.botConfig.heartbeat.enabled) {
      return;
    }

    const delayMs = this.getNextHeartbeatDelayMs();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.runHeartbeatCycle();
    }, delayMs);
    this.heartbeatTimer.unref?.();
  }

  private getNextHeartbeatDelayMs(): number {
    const heartbeat = this.runtimeContext.botConfig.heartbeat;
    if (heartbeat.randomIntervalMs) {
      return randomIntInclusive(heartbeat.randomIntervalMs[0], heartbeat.randomIntervalMs[1]);
    }

    return heartbeat.intervalMs ?? 0;
  }

  private async runHeartbeatCycle(): Promise<void> {
    if (this.heartbeatRunning || this.stopping || !this.runtimeContext.botConfig.heartbeat.enabled) {
      return;
    }

    this.heartbeatRunning = true;
    try {
      await this.processHeartbeatBacklog();
    } catch (error) {
      this.logger.error("heartbeat cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.heartbeatRunning = false;
      this.scheduleNextHeartbeat();
    }
  }

  private async processHeartbeatBacklog(): Promise<void> {
    const candidateChatIds = this.db.listChatsWithHeartbeatBacklog();
    if (candidateChatIds.length === 0) {
      return;
    }

    for (const chatId of candidateChatIds) {
      if (this.stopping) {
        return;
      }

      const chat = this.db.getChatById(chatId);
      if (!chat) {
        continue;
      }

      const reviewMessages = this.db.getHeartbeatReviewMessages(chatId, this.runtimeContext.botConfig.heartbeat.batchSize);
      const lastReviewMessage = reviewMessages[reviewMessages.length - 1];
      if (reviewMessages.length === 0 || !lastReviewMessage) {
        continue;
      }

      if (!this.isReplyAllowed(chat.jid, chat.type)) {
        this.db.markChatReviewedThrough(chatId, lastReviewMessage.id, new Date().toISOString());
        continue;
      }

      if (this.db.getPendingTurnMessages(chatId).length > 0) {
        continue;
      }

      const decisionStartedAt = Date.now();
      const generated = await this.heartbeatService.generateForReview(chatId, reviewMessages);
      const decisionMs = Date.now() - decisionStartedAt;

      if (!generated.shouldReply) {
        this.db.markChatReviewedThrough(chatId, lastReviewMessage.id, generated.memoryAppliedAt);
        this.logger.info("heartbeat stayed silent", {
          chatId,
          chatJid: chat.jid,
          chatType: chat.type,
          reviewedMessageCount: reviewMessages.length,
          decisionMs
        });
        continue;
      }

      if (this.db.getPendingTurnMessages(chatId).length > 0) {
        this.db.markChatReviewedThrough(chatId, lastReviewMessage.id, generated.memoryAppliedAt);
        continue;
      }

      const bubbles = prepareReplyBubbles(generated.reply, {
        botId: this.runtimeContext.botConfig.botId,
        messagePrefix: this.runtimeContext.botConfig.messagePrefix
      });
      if (bubbles.length === 0) {
        this.db.markChatReviewedThrough(chatId, lastReviewMessage.id, generated.memoryAppliedAt);
        this.logger.info("heartbeat sanitized to silence", {
          chatId,
          chatJid: chat.jid,
          chatType: chat.type,
          reviewedMessageCount: reviewMessages.length,
          decisionMs
        });
        continue;
      }

      const sent = await this.runWithTypingPresence(chat.jid, async () => this.sendReply(chat.jid, chat.type, bubbles));
      const completedAt = new Date().toISOString();
      this.db.markChatReviewedThrough(chatId, lastReviewMessage.id, completedAt);

      this.logger.info("heartbeat replied", {
        chatId,
        chatJid: chat.jid,
        chatType: chat.type,
        reviewedMessageCount: reviewMessages.length,
        bubbleCount: sent.bubbleCount,
        decisionMs,
        sendMs: sent.sendMs
      });
    }
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

  private applyMessagePrefix(text: string): string {
    const prefix = this.runtimeContext.botConfig.messagePrefix;
    return prefix ? `${prefix}${text}` : text;
  }

  private async sendReply(chatJid: string, chatType: ChatType, bubbles: string[]): Promise<{ bubbleCount: number; sendMs: number }> {
    const sendStartedAt = Date.now();

    for (let index = 0; index < bubbles.length; index += 1) {
      const bubble = bubbles[index];
      if (!bubble) {
        continue;
      }

      const outboundText = this.applyMessagePrefix(bubble);
      const sent = await this.transport.sendText(chatJid, outboundText);
      this.db.createBotMessage(
        chatJid,
        chatType,
        this.botJid,
        sent.externalId,
        bubble,
        outboundText,
        sent.timestamp,
        this.runtimeContext.botConfig.blockSize
      );

      const isLastBubble = index === bubbles.length - 1;
      if (!isLastBubble) {
        const [minDelay, maxDelay] = this.runtimeContext.botConfig.bubbleDelayMs;
        await sleep(randomIntInclusive(minDelay, maxDelay));
      }
    }

    return {
      bubbleCount: bubbles.length,
      sendMs: Date.now() - sendStartedAt
    };
  }

  private clearTurnRetry(chatId: number): void {
    const timer = this.turnRetryTimers.get(chatId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.turnRetryTimers.delete(chatId);
  }

  private scheduleTurnRetry(chatId: number): void {
    if (this.stopping || this.turnRetryTimers.has(chatId)) {
      return;
    }

    const delayMs = this.turnRetryDelayMs.get(chatId) ?? ChatRuntime.turnRetryInitialMs;
    const timer = setTimeout(() => {
      this.turnRetryTimers.delete(chatId);
      this.queue.enqueue(chatId);
    }, delayMs);
    timer.unref?.();

    this.turnRetryTimers.set(chatId, timer);
    this.turnRetryDelayMs.set(chatId, Math.min(delayMs * 2, ChatRuntime.turnRetryMaxMs));

    this.logger.warn("scheduled turn retry", {
      chatId,
      delayMs
    });
  }
}
