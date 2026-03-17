import { afterEach, describe, expect, it } from "vitest";

import { MemoryService } from "../src/memory.js";
import { cleanupTempRoot, createDb, createTempRoot, FakeGateway } from "./helpers.js";

describe("memory retrieval", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("uses structured memory search first and skips archive fallback when it has enough hits", async () => {
    const root = createTempRoot();
    roots.push(root);
    const db = createDb(root);
    const gateway = new FakeGateway({
      __default: [1, 0, 0],
      "fact\nloves pizza\n": [1, 0, 0],
      pizza: [1, 0, 0]
    });
    const memoryService = new MemoryService(db, gateway, 1);

    await memoryService.remember({
      category: "fact",
      summary: "loves pizza",
      sourceBlock: null,
      sourceChat: null,
      createdAt: "2026-03-17T10:00:00.000Z"
    });

    const result = await memoryService.retrieveForTurn("pizza");
    expect(result.memories).toHaveLength(1);
    expect(result.archiveHits).toHaveLength(0);
  });

  it("falls back to archived transcripts when structured hits are below the threshold", async () => {
    const root = createTempRoot();
    roots.push(root);
    const db = createDb(root);
    const gateway = new FakeGateway({
      __default: [0, 1, 0],
      pasta: [0, 1, 0]
    });
    const memoryService = new MemoryService(db, gateway, 3);

    const ingest = db.ingestMessage(
      {
        chatJid: "chat@s.whatsapp.net",
        chatType: "dm",
        senderJid: "user@s.whatsapp.net",
        senderName: "User",
        externalId: "archive-1",
        contentType: "text",
        text: "We talked about pasta in Rome",
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
    db.markBlockStatus(ingest.closedBlockId!, "done", "2026-03-17T10:00:01.000Z");

    const result = await memoryService.retrieveForTurn("pasta");
    expect(result.memories).toHaveLength(0);
    expect(result.archiveHits).toHaveLength(1);
    expect(result.archiveHits[0]?.text).toContain("pasta");
  });
});
