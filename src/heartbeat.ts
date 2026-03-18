import type { RuntimeContext, StoredMessage } from "./domain.js";
import type { LunaDb } from "./db.js";
import type { LanguageGateway } from "./llm.js";
import { formatArchiveHits, formatRetrievedMemories, MemoryService } from "./memory.js";
import { formatMessageContent } from "./message-content.js";

export class HeartbeatService {
  constructor(
    private readonly db: LunaDb,
    private readonly gateway: LanguageGateway,
    private readonly memoryService: MemoryService,
    private readonly runtimeContext: RuntimeContext
  ) {}

  async generateForReview(chatId: number, reviewMessages: StoredMessage[]): Promise<{
    shouldReply: boolean;
    reply: string;
    memoryAppliedAt: string;
    sourceBlock: number | null;
    sourceChat: number;
  }> {
    if (reviewMessages.length === 0) {
      throw new Error("generateForReview requires at least one review message.");
    }

    const chat = this.db.getChatById(chatId);
    if (!chat) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }

    const firstReviewMessageId = reviewMessages[0]?.id ?? Number.MAX_SAFE_INTEGER;
    const recentWindow = this.db
      .getRecentWindow(chatId)
      .filter((message) => message.id < firstReviewMessageId)
      .slice(-this.runtimeContext.rootConfig.recentWindowMessageLimit);
    const reviewQuery = reviewMessages
      .map((message) => formatMessageContent(message))
      .filter(Boolean)
      .join("\n");

    const retrieval = await this.memoryService.retrieveForTurn(reviewQuery);
    const decision = await this.gateway.generateHeartbeatDecision({
      persona: this.runtimeContext.persona,
      heartbeatInstructions: this.runtimeContext.heartbeatInstructions ?? "",
      botId: this.runtimeContext.botConfig.botId,
      messagePrefix: this.runtimeContext.botConfig.messagePrefix,
      chatType: chat.type,
      recentWindow,
      retrievedMemoryBlock: formatRetrievedMemories(retrieval.memories),
      archiveFallbackBlock: formatArchiveHits(retrieval.archiveHits),
      reviewMessages,
      adminSenders: reviewMessages
        .map((message) => message.senderJid)
        .filter((senderJid) => this.runtimeContext.botConfig.admins.includes(senderJid))
    });

    const createdAt = new Date().toISOString();
    await this.memoryService.applyGeneratedOperations(
      decision.memoryOperations,
      reviewMessages[0]?.blockId ?? null,
      chatId,
      createdAt
    );

    const reply = decision.reply.trim();
    return {
      shouldReply: decision.shouldReply && reply.length > 0,
      reply,
      memoryAppliedAt: createdAt,
      sourceBlock: reviewMessages[0]?.blockId ?? null,
      sourceChat: chatId
    };
  }
}
