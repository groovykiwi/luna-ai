import type { RuntimeContext, StoredMessage } from "./domain.js";
import type { LunaDb } from "./db.js";
import type { LanguageGateway } from "./llm.js";
import { formatArchiveHits, formatRetrievedMemories, MemoryService } from "./memory.js";
import { sanitizeGeneratedBubble } from "./output.js";
import { chunkText } from "./utils.js";

export function splitReplyIntoBubbles(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return [];
  }

  const bubbles: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 280) {
      bubbles.push(paragraph);
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let current = "";
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence}` : sentence;
      if (candidate.length <= 280) {
        current = candidate;
        continue;
      }

      if (current) {
        bubbles.push(current.trim());
      }
      const chunks = chunkText(sentence, 280);
      bubbles.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? "";
    }

    if (current.trim()) {
      bubbles.push(current.trim());
    }
  }

  return bubbles.filter(Boolean);
}

export function prepareReplyBubbles(text: string, input: { botId: string; messagePrefix: string }): string[] {
  return splitReplyIntoBubbles(text)
    .map((bubble) => sanitizeGeneratedBubble(bubble, input))
    .filter(Boolean);
}

export class ReplyService {
  constructor(
    private readonly db: LunaDb,
    private readonly gateway: LanguageGateway,
    private readonly memoryService: MemoryService,
    private readonly runtimeContext: RuntimeContext
  ) {}

  async generateForTurn(chatId: number, pendingMessages: StoredMessage[]): Promise<{
    reply: string;
    memoryAppliedAt: string;
    sourceBlock: number | null;
    sourceChat: number;
  }> {
    if (pendingMessages.length === 0) {
      throw new Error("generateForTurn requires at least one pending message.");
    }

    const chat = this.db.getChatById(chatId);
    if (!chat) {
      throw new Error(`Chat ${chatId} does not exist.`);
    }

    // Bound hot-path prompt size; older context remains available through retrieval and archive fallback.
    const firstPendingMessageId = pendingMessages[0]?.id ?? Number.MAX_SAFE_INTEGER;
    const recentWindow = this.db
      .getRecentWindow(chatId)
      // The live turn is provided separately below; keep the history block to prior context only.
      .filter((message) => message.id < firstPendingMessageId)
      .slice(-this.runtimeContext.rootConfig.recentWindowMessageLimit);
    const turnQuery = pendingMessages
      .map((message) => [message.text, message.imageDescription].filter(Boolean).join(" ").trim())
      .filter(Boolean)
      .join("\n");

    const retrieval = await this.memoryService.retrieveForTurn(turnQuery);
    const replyEnvelope = await this.gateway.generateReply({
      persona: this.runtimeContext.persona,
      botId: this.runtimeContext.botConfig.botId,
      messagePrefix: this.runtimeContext.botConfig.messagePrefix,
      chatType: chat.type,
      recentWindow,
      retrievedMemoryBlock: formatRetrievedMemories(retrieval.memories),
      archiveFallbackBlock: formatArchiveHits(retrieval.archiveHits),
      pendingMessages,
      adminSenders: pendingMessages
        .map((message) => message.senderJid)
        .filter((senderJid) => this.runtimeContext.botConfig.admins.includes(senderJid))
    });

    const createdAt = new Date().toISOString();
    await this.memoryService.applyGeneratedOperations(
      replyEnvelope.memoryOperations,
      pendingMessages[0]?.blockId ?? null,
      chatId,
      createdAt
    );

    return {
      reply: replyEnvelope.reply.trim(),
      memoryAppliedAt: createdAt,
      sourceBlock: pendingMessages[0]?.blockId ?? null,
      sourceChat: chatId
    };
  }
}
