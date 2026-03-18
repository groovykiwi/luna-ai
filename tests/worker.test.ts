import { existsSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { BackgroundWorker } from "../src/worker.js";
import { createLogger } from "../src/logging.js";
import {
  cleanupTempRoot,
  createDb,
  createRuntimeContext,
  createTempRoot,
  FakeGateway
} from "./helpers.js";

describe("background worker", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("reclaims stale running jobs on startup", () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const db = createDb(root);
    const gateway = new FakeGateway();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/worker-test.log`, "worker-test");
    const jobId = db.enqueueJob("reindex", {}, "2026-03-17T10:00:00.000Z");
    db.connection
      .prepare("UPDATE jobs SET status = 'running', started_at = '2026-03-17T10:00:00.000Z' WHERE id = ?")
      .run(jobId);

    const worker = new BackgroundWorker(runtimeContext, db, gateway, logger);
    expect(worker.initialize()).toBe(1);

    const status = db.connection
      .prepare("SELECT status FROM jobs WHERE id = ?")
      .get(jobId) as { status: string };
    expect(status.status).toBe("queued");
  });

  it("does not reclaim fresh running jobs on startup", () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const db = createDb(root);
    const gateway = new FakeGateway();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/worker-fresh.log`, "worker-fresh");
    const now = new Date().toISOString();
    const jobId = db.enqueueJob("reindex", {}, now);
    db.connection
      .prepare("UPDATE jobs SET status = 'running', started_at = ?, lease_token = 'fresh-lease' WHERE id = ?")
      .run(now, jobId);

    const worker = new BackgroundWorker(runtimeContext, db, gateway, logger);
    expect(worker.initialize()).toBe(0);

    const status = db.connection
      .prepare("SELECT status, lease_token AS leaseToken FROM jobs WHERE id = ?")
      .get(jobId) as { status: string; leaseToken: string | null };
    expect(status.status).toBe("running");
    expect(status.leaseToken).toBe("fresh-lease");
  });

  it("extracts only memory-eligible messages and marks blocks done on success", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const db = createDb(root);
    const gateway = new FakeGateway({
      __default: [1, 0, 0],
      "fact\nlikes tea\n": [1, 0, 0]
    });
    gateway.extractionResult = [{ category: "fact", summary: "likes tea" }];
    const logger = createLogger(`${runtimeContext.paths.logsDir}/worker-success.log`, "worker-success");

    db.ingestMessage(
      {
        chatJid: "group@g.us",
        chatType: "group",
        senderJid: "ambient@s.whatsapp.net",
        senderName: "Ambient",
        externalId: "ambient",
        contentType: "text",
        text: "ambient message",
        imageDescription: null,
        quotedExternalId: null,
        mentions: [],
        rawJson: "{}",
        createdAt: "2026-03-17T10:00:00.000Z",
        isFromBot: false
      },
      {
        contextOnly: true,
        memoryEligible: false,
        wasTriggered: false,
        turnEligible: false
      },
      2
    );

    const ingest = db.ingestMessage(
      {
        chatJid: "group@g.us",
        chatType: "group",
        senderJid: "user@s.whatsapp.net",
        senderName: "User",
        externalId: "triggered",
        contentType: "text",
        text: "remember I like tea",
        imageDescription: null,
        quotedExternalId: null,
        mentions: [],
        rawJson: "{}",
        createdAt: "2026-03-17T10:00:01.000Z",
        isFromBot: false
      },
      {
        contextOnly: false,
        memoryEligible: true,
        wasTriggered: true,
        turnEligible: true
      },
      2
    );

    const worker = new BackgroundWorker(runtimeContext, db, gateway, logger);
    const processed = await worker.runOnce();
    expect(processed).toBe(true);
    expect(gateway.extractionInputs[0]).toHaveLength(1);

    const block = db.connection
      .prepare("SELECT status FROM blocks WHERE id = ?")
      .get(ingest.closedBlockId) as { status: string };
    const memory = db.connection
      .prepare("SELECT summary FROM memory_items ORDER BY id ASC LIMIT 1")
      .get() as { summary: string };

    expect(block.status).toBe("done");
    expect(memory.summary).toBe("likes tea");
  });

  it("marks block extraction as failed when the extract lane throws", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const db = createDb(root);
    const gateway = new FakeGateway();
    gateway.shouldThrowOnExtract = true;
    const logger = createLogger(`${runtimeContext.paths.logsDir}/worker-failure.log`, "worker-failure");

    const ingest = db.ingestMessage(
      {
        chatJid: "chat@s.whatsapp.net",
        chatType: "dm",
        senderJid: "user@s.whatsapp.net",
        senderName: "User",
        externalId: "msg-1",
        contentType: "text",
        text: "hello",
        imageDescription: null,
        quotedExternalId: null,
        mentions: [],
        rawJson: "{}",
        createdAt: "2026-03-17T10:00:00.000Z",
        isFromBot: false
      },
      {
        contextOnly: false,
        memoryEligible: true,
        wasTriggered: true,
        turnEligible: true
      },
      1
    );

    const worker = new BackgroundWorker(runtimeContext, db, gateway, logger);
    const processed = await worker.runOnce();
    expect(processed).toBe(true);

    const block = db.connection
      .prepare("SELECT status, extraction_error AS extractionError FROM blocks WHERE id = ?")
      .get(ingest.closedBlockId) as { status: string; extractionError: string };
    const job = db.connection
      .prepare("SELECT status FROM jobs ORDER BY id ASC LIMIT 1")
      .get() as { status: string };
    const rawPayload = db.connection
      .prepare("SELECT raw_json AS rawJson FROM messages WHERE id = ?")
      .get(ingest.messageId) as { rawJson: string };

    expect(block.status).toBe("failed");
    expect(block.extractionError).toContain("extract failed");
    expect(job.status).toBe("failed");
    expect(rawPayload.rawJson).toBe("{\"compacted\":true}");
  });

  it("prunes failed media even when a closed block has no extraction candidates", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const db = createDb(root);
    const gateway = new FakeGateway();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/worker-prune-media.log`, "worker-prune-media");
    const mediaPath = `${runtimeContext.paths.mediaDir}/failed-image.jpg`;
    writeFileSync(mediaPath, "image-bytes");

    const ingest = db.ingestMessage(
      {
        chatJid: "chat@s.whatsapp.net",
        chatType: "dm",
        senderJid: "user@s.whatsapp.net",
        senderName: "User",
        externalId: "image-1",
        contentType: "image",
        text: null,
        imageDescription: null,
        quotedExternalId: null,
        mentions: [],
        rawJson: "{\"provider\":\"payload\"}",
        createdAt: "2026-03-17T10:00:00.000Z",
        isFromBot: false,
        mediaFilePath: mediaPath,
        mediaMimeType: "image/jpeg",
        mediaErrorMessage: "vision failed"
      },
      {
        contextOnly: false,
        memoryEligible: true,
        wasTriggered: true,
        turnEligible: true
      },
      1
    );

    const worker = new BackgroundWorker(runtimeContext, db, gateway, logger);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);

    const media = db.connection
      .prepare("SELECT status, error_message AS errorMessage FROM media WHERE message_id = ?")
      .get(ingest.messageId) as { status: string; errorMessage: string | null };
    const rawPayload = db.connection
      .prepare("SELECT raw_json AS rawJson FROM messages WHERE id = ?")
      .get(ingest.messageId) as { rawJson: string };

    expect(media.status).toBe("pruned");
    expect(media.errorMessage).toBe("vision failed");
    expect(rawPayload.rawJson).toBe("{\"compacted\":true}");
    expect(existsSync(mediaPath)).toBe(false);
  });
});
