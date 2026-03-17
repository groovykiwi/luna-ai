import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempRoot, createDb, createTempRoot } from "./helpers.js";

describe("block rollover and ingest flags", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("persists ambient messages but excludes them from memory extraction and closes blocks at the threshold", () => {
    const root = createTempRoot();
    roots.push(root);
    const db = createDb(root);

    db.ingestMessage(
      {
        chatJid: "group@g.us",
        chatType: "group",
        senderJid: "user-1@s.whatsapp.net",
        senderName: "User 1",
        externalId: "m1",
        contentType: "text",
        text: "ambient one",
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

    const result = db.ingestMessage(
      {
        chatJid: "group@g.us",
        chatType: "group",
        senderJid: "user-2@s.whatsapp.net",
        senderName: "User 2",
        externalId: "m2",
        contentType: "text",
        text: "ambient two",
        imageDescription: null,
        quotedExternalId: null,
        mentions: [],
        rawJson: "{}",
        createdAt: "2026-03-17T10:00:01.000Z",
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

    const block = db.connection
      .prepare("SELECT status, message_count AS messageCount FROM blocks WHERE id = ?")
      .get(result.closedBlockId) as { status: string; messageCount: number };
    const message = db.connection
      .prepare("SELECT context_only AS contextOnly, memory_eligible AS memoryEligible FROM messages WHERE external_id = 'm1'")
      .get() as { contextOnly: number; memoryEligible: number };
    const job = db.connection
      .prepare("SELECT type, status FROM jobs ORDER BY id ASC LIMIT 1")
      .get() as { type: string; status: string };

    expect(result.blockClosed).toBe(true);
    expect(block).toEqual({
      status: "queued",
      messageCount: 2
    });
    expect(message).toEqual({
      contextOnly: 1,
      memoryEligible: 0
    });
    expect(job).toEqual({
      type: "extract_block",
      status: "queued"
    });
  });
});
