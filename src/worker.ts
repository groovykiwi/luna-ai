import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

import type { RuntimeContext } from "./domain.js";
import type { LunaDb } from "./db.js";
import type { LanguageGateway } from "./llm.js";
import type { Logger } from "./logging.js";
import { MemoryService } from "./memory.js";
import { sleep } from "./utils.js";

export class BackgroundWorker {
  private readonly memoryService: MemoryService;

  private readonly workerLeaseToken = randomUUID();

  private running = true;

  constructor(
    private readonly runtimeContext: RuntimeContext,
    private readonly db: LunaDb,
    private readonly gateway: LanguageGateway,
    private readonly logger: Logger
  ) {
    this.memoryService = new MemoryService(db, gateway, runtimeContext.botConfig.retrievalMinHits);
  }

  initialize(): number {
    const now = new Date();
    const reclaimed = this.db.reclaimRunningJobs(
      now.toISOString(),
      new Date(now.getTime() - this.runtimeContext.rootConfig.staleJobAfterMs).toISOString()
    );
    if (reclaimed > 0) {
      this.logger.warn("reclaimed stale jobs", { count: reclaimed });
    }
    return reclaimed;
  }

  async start(): Promise<void> {
    this.initialize();
    while (this.running) {
      const processed = await this.runOnce();
      if (!processed) {
        await sleep(this.runtimeContext.rootConfig.workerPollIntervalMs);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  async runOnce(): Promise<boolean> {
    const job = this.db.claimNextJob(new Date().toISOString(), this.workerLeaseToken);
    if (!job) {
      return false;
    }

    try {
      await this.handleJob(job);
      if (!job.leaseToken || !this.db.completeJob(job.id, job.leaseToken, new Date().toISOString())) {
        this.logger.warn("job lease was lost before completion", {
          jobId: job.id,
          type: job.type
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stillOwnsLease = job.leaseToken ? this.db.stillOwnsJobLease(job.id, job.leaseToken) : false;
      if (job.type === "extract_block") {
        const payload = JSON.parse(job.payloadJson) as { blockId?: number };
        if (payload.blockId && stillOwnsLease) {
          this.db.markBlockStatus(payload.blockId, "failed", new Date().toISOString(), message);
          this.db.compactRawPayloadsForBlock(payload.blockId);
          if (!this.runtimeContext.botConfig.retainProcessedMedia) {
            this.db.enqueueJob("prune_media", {}, new Date().toISOString());
          }
        }
      }
      if (!job.leaseToken || !this.db.failJob(job.id, job.leaseToken, new Date().toISOString(), message)) {
        this.logger.warn("job lease was lost before failure could be recorded", {
          jobId: job.id,
          type: job.type,
          error: message
        });
      } else {
        this.logger.error("job failed", {
          jobId: job.id,
          type: job.type,
          error: message
        });
      }
    }

    return true;
  }

  private async handleJob(job: import("./db.js").JobRow): Promise<void> {
    const payload = JSON.parse(job.payloadJson) as { blockId?: number };
    switch (job.type) {
      case "extract_block": {
        if (!payload.blockId) {
          throw new Error("extract_block job missing blockId");
        }

        const blockId = payload.blockId;
        const now = new Date().toISOString();
        this.db.markBlockStatus(blockId, "running", now);
        const candidates = this.db.getExtractionCandidates(blockId)
          .map((candidate) => ({
            senderJid: candidate.senderJid,
            isFromBot: candidate.isFromBot,
            text: [candidate.text, candidate.imageDescription ? `[image] ${candidate.imageDescription}` : null]
              .filter(Boolean)
              .join(" ")
              .trim()
          }))
          .filter((candidate) => candidate.text);

        if (candidates.length === 0) {
          this.db.markBlockStatus(blockId, "done", now);
          this.db.compactRawPayloadsForBlock(blockId);
          if (!this.runtimeContext.botConfig.retainProcessedMedia) {
            this.db.enqueueJob("prune_media", {}, now);
          }
          return;
        }

        const memories = await this.gateway.extractMemories({
          persona: this.runtimeContext.persona,
          botId: this.runtimeContext.botConfig.botId,
          messages: candidates as Array<{ senderJid: string; isFromBot: boolean; text: string }>
        });
        if (!job.leaseToken || !this.db.stillOwnsJobLease(job.id, job.leaseToken)) {
          this.logger.warn("job lease was lost during block extraction", {
            jobId: job.id,
            blockId
          });
          return;
        }
        await this.memoryService.applyExtractedMemories(memories, blockId, this.db.getBlockChatId(blockId), now);
        this.db.markBlockStatus(blockId, "done", now);
        this.db.compactRawPayloadsForBlock(blockId);
        if (!this.runtimeContext.botConfig.retainProcessedMedia) {
          this.db.enqueueJob("prune_media", {}, now);
        }
        return;
      }

      case "reindex":
        await this.memoryService.reindexAll(new Date().toISOString());
        return;

      case "prune_media": {
        for (const media of this.db.listPrunableMedia()) {
          try {
            unlinkSync(media.filePath);
          } catch {
            // If an operator removed the file manually, treat it as already pruned.
          }
          this.db.markMediaPruned(media.id, new Date().toISOString());
        }
        return;
      }
    }
  }
}
