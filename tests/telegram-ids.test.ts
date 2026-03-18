import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { runTelegramIdsCli } from "../src/bin/telegram-ids.js";
import { LunaDb } from "../src/db.js";
import { cleanupTempRoot, createRuntimeContext, createTempRoot } from "./helpers.js";

function createCapturedStdout(): {
  stream: Pick<NodeJS.WriteStream, "write">;
  read: () => string;
} {
  let output = "";

  return {
    stream: {
      write(chunk: string | Uint8Array) {
        output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      }
    },
    read() {
      return output;
    }
  };
}

describe("telegram ids cli", () => {
  it("prints Telegram chat IDs and user IDs in bot.json format", () => {
    const root = createTempRoot();
    const runtimeContext = createRuntimeContext(root);

    try {
      writeFileSync(runtimeContext.paths.personaPath, "You are Maya.\n");
      writeFileSync(
        runtimeContext.paths.botConfigPath,
        JSON.stringify(
          {
            botId: "maya",
            provider: "telegram",
            telegram: {
              admins: [],
              replyWhitelist: {
                dms: []
              }
            }
          },
          null,
          2
        )
      );

      const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
      db.ingestMessage(
        {
          chatJid: "tg:chat:123456789",
          chatType: "dm",
          senderJid: "tg:user:123456789",
          senderName: "Nate",
          externalId: "tg:msg:123456789:1",
          contentType: "text",
          text: "hello",
          imageDescription: null,
          quotedExternalId: null,
          mentions: [],
          rawJson: "{\"message\":\"hello\"}",
          createdAt: "2026-03-18T11:00:00.000Z",
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
      db.close();

      const stdout = createCapturedStdout();
      runTelegramIdsCli({
        stdout: stdout.stream,
        loadRuntimeContext: () => runtimeContext
      });

      expect(stdout.read()).toContain('Telegram IDs for bot "maya"');
      expect(stdout.read()).toContain("telegram.replyWhitelist.dms: tg:chat:123456789");
      expect(stdout.read()).toContain("telegram.admins: tg:user:123456789");
      expect(stdout.read()).toContain("1. Nate");
    } finally {
      cleanupTempRoot(root);
    }
  });

  it("explains how to seed the database when no Telegram messages exist", () => {
    const root = createTempRoot();
    const runtimeContext = createRuntimeContext(root);

    try {
      const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
      db.close();

      const stdout = createCapturedStdout();
      runTelegramIdsCli({
        stdout: stdout.stream,
        loadRuntimeContext: () => runtimeContext
      });

      expect(stdout.read()).toContain("No Telegram DMs found yet.");
      expect(stdout.read()).toContain("Send the bot a Telegram DM first");
    } finally {
      cleanupTempRoot(root);
    }
  });

  it("explains how to seed the database when bot.db does not exist yet", () => {
    const root = createTempRoot();
    const runtimeContext = createRuntimeContext(root);

    try {
      const stdout = createCapturedStdout();
      runTelegramIdsCli({
        stdout: stdout.stream,
        loadRuntimeContext: () => runtimeContext
      });

      expect(stdout.read()).toContain("No Telegram DMs found yet.");
      expect(stdout.read()).toContain("Send the bot a Telegram DM first");
    } finally {
      cleanupTempRoot(root);
    }
  });
});
