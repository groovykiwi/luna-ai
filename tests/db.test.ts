import { writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { LunaDb } from "../src/db.js";
import { cleanupTempRoot, createTempRoot } from "./helpers.js";

describe("database open errors", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("wraps corruption-like sqlite failures with recovery guidance", () => {
    const root = createTempRoot();
    roots.push(root);
    const dbPath = `${root}/bot.db`;
    writeFileSync(dbPath, "not a sqlite database");

    expect(() => new LunaDb(dbPath, 5_000)).toThrow(/appears corrupt or unreadable/);
    expect(() => new LunaDb(dbPath, 5_000)).toThrow(/move\/remove it to let Luna create a fresh database/);
  });

  it("claims pending turn messages exclusively until they are unlocked or processed", () => {
    const root = createTempRoot();
    roots.push(root);
    const db = new LunaDb(`${root}/bot.db`, 5_000);

    try {
      db.ingestMessage(
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
          createdAt: "2026-03-18T10:00:00.000Z",
          isFromBot: false
        },
        {
          contextOnly: false,
          memoryEligible: true,
          wasTriggered: true,
          turnEligible: true
        },
        50
      );

      const firstClaim = db.claimPendingTurnMessages(1, "2026-03-18T10:00:01.000Z");
      expect(firstClaim).toHaveLength(1);
      expect(db.claimPendingTurnMessages(1, "2026-03-18T10:00:02.000Z")).toHaveLength(0);

      db.unlockTurnMessages(firstClaim.map((message) => message.id));
      expect(db.claimPendingTurnMessages(1, "2026-03-18T10:00:03.000Z")).toHaveLength(1);

      db.markTurnMessagesProcessed(firstClaim.map((message) => message.id), "2026-03-18T10:00:04.000Z");
      expect(db.claimPendingTurnMessages(1, "2026-03-18T10:00:05.000Z")).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
