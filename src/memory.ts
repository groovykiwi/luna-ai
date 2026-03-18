import { encodeEmbedding } from "./db.js";
import type { ArchiveHit, ExtractedMemory, MemoryOperation, RetrievedMemory } from "./domain.js";
import type { LunaDb } from "./db.js";
import type { LanguageGateway } from "./llm.js";
import { rootConfig } from "./config.js";

function buildArchiveQuery(input: string): string | null {
  const terms = Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    )
  ).slice(0, 6);

  if (terms.length === 0) {
    return null;
  }

  return terms.join(" OR ");
}

export class MemoryService {
  constructor(
    private readonly db: LunaDb,
    private readonly gateway: LanguageGateway,
    private readonly retrievalMinHits: number
  ) {}

  async retrieveForTurn(query: string): Promise<{
    memories: RetrievedMemory[];
    archiveHits: ArchiveHit[];
  }> {
    if (!query.trim()) {
      return {
        memories: [],
        archiveHits: []
      };
    }

    const embedding = await this.gateway.embedText(query);
    const memories = this.db.searchActiveMemoriesByEmbedding(
      embedding,
      rootConfig.memorySearchLimit,
      rootConfig.memorySearchCandidateLimit
    );
    const archiveQuery = memories.length < this.retrievalMinHits ? buildArchiveQuery(query) : null;
    const archiveHits = archiveQuery ? this.db.searchArchivedMessages(archiveQuery, rootConfig.rawArchiveSearchLimit) : [];

    return {
      memories,
      archiveHits
    };
  }

  async remember(input: {
    category: ExtractedMemory["category"];
    summary: string;
    details?: string | undefined;
    sourceBlock: number | null;
    sourceChat: number | null;
    createdAt: string;
  }): Promise<number | null> {
    const normalizedSummary = input.summary.trim().toLowerCase();
    const normalizedDetails = (input.details ?? "").trim().toLowerCase();
    const duplicate = this.db.findActiveMemoryByNormalizedKey(input.category, normalizedSummary, normalizedDetails);

    if (duplicate) {
      return duplicate.id;
    }

    const embeddingValues = await this.gateway.embedText(
      `${input.category}\n${input.summary}\n${input.details ?? ""}`.trim()
    );
    const similar = this.db.searchActiveMemoriesByEmbedding(
      embeddingValues,
      1,
      rootConfig.memorySearchCandidateLimit
    )[0];
    const memoryId = this.db.insertMemory(
      input.category,
      input.summary,
      input.details ?? null,
      input.sourceBlock,
      input.sourceChat,
      encodeEmbedding(embeddingValues),
      input.createdAt
    );

    // v1 keeps supersession local and simple: the newest near-duplicate active fact replaces the old one.
    if (similar && similar.score >= 0.92 && similar.id !== memoryId) {
      this.db.markMemorySuperseded(similar.id, memoryId, input.createdAt);
    }

    return memoryId;
  }

  async forget(query: string, createdAt: string): Promise<number> {
    const matches = this.db.searchMemoriesForForget(query, rootConfig.inlineForgetSearchLimit);
    for (const match of matches) {
      this.db.markMemorySuperseded(match.id, null, createdAt);
    }

    return matches.length;
  }

  async applyGeneratedOperations(
    operations: MemoryOperation[],
    sourceBlock: number | null,
    sourceChat: number | null,
    createdAt: string
  ): Promise<void> {
    for (const operation of operations) {
      if (operation.type === "forget") {
        await this.forget(operation.query, createdAt);
        continue;
      }

      await this.remember({
        category: operation.category,
        summary: operation.summary,
        details: operation.details,
        sourceBlock,
        sourceChat,
        createdAt
      });
    }
  }

  async applyExtractedMemories(
    memories: ExtractedMemory[],
    sourceBlock: number,
    sourceChat: number | null,
    createdAt: string
  ): Promise<void> {
    for (const memory of memories) {
      await this.remember({
        category: memory.category,
        summary: memory.summary,
        details: memory.details,
        sourceBlock,
        sourceChat,
        createdAt
      });
    }
  }

  async reindexAll(createdAt: string): Promise<void> {
    for (const memoryId of this.db.listActiveMemoryIds()) {
      const memory = this.db.getMemory(memoryId);
      if (!memory) {
        continue;
      }

      const embeddingValues = await this.gateway.embedText(
        `${memory.category}\n${memory.summary}\n${memory.details ?? ""}`.trim()
      );
      this.db.updateMemoryEmbedding(memory.id, encodeEmbedding(embeddingValues), createdAt);
    }
  }
}

export function formatRetrievedMemories(memories: RetrievedMemory[]): string {
  if (memories.length === 0) {
    return "";
  }

  return memories
    .map((memory) => `- [${memory.category}] ${memory.summary}${memory.details ? ` (${memory.details})` : ""}`)
    .join("\n");
}

export function formatArchiveHits(archiveHits: ArchiveHit[]): string {
  if (archiveHits.length === 0) {
    return "";
  }

  return archiveHits
    .map((hit) => `- ${hit.chatJid} ${hit.senderJid}: ${hit.text}`)
    .join("\n");
}
