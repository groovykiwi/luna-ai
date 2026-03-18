import { describe, expect, it } from "vitest";

import { runWhatsAppIdsCli } from "../src/bin/whatsapp-ids.js";
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

describe("whatsapp ids cli", () => {
  it("prints WhatsApp DM, group, and user IDs in bot.json format", () => {
    const root = createTempRoot();
    const runtimeContext = createRuntimeContext(root);

    try {
      const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
      db.ingestMessage(
        {
          chatJid: "393123456789@s.whatsapp.net",
          chatType: "dm",
          senderJid: "393123456789@s.whatsapp.net",
          senderName: "Nate",
          externalId: "dm-1",
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
      db.ingestMessage(
        {
          chatJid: "120363012345678901@g.us",
          chatType: "group",
          senderJid: "393123456789@s.whatsapp.net",
          senderName: "Nate",
          externalId: "group-1",
          contentType: "text",
          text: "@maya hi",
          imageDescription: null,
          quotedExternalId: null,
          mentions: [],
          rawJson: "{\"message\":\"@maya hi\"}",
          createdAt: "2026-03-18T11:05:00.000Z",
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
      runWhatsAppIdsCli({
        stdout: stdout.stream,
        loadRuntimeContext: () => runtimeContext
      });

      const output = stdout.read();
      expect(output).toContain('WhatsApp IDs for bot "maya"');
      expect(output).toContain("whatsapp.replyWhitelist.dms: 393123456789@s.whatsapp.net");
      expect(output).toContain("whatsapp.replyWhitelist.groups: 120363012345678901@g.us");
      expect(output).toContain("whatsapp.admins: 393123456789@s.whatsapp.net");
      expect(output).toContain("DM chats");
      expect(output).toContain("Group chats");
      expect(output).toContain("Recent users");
    } finally {
      cleanupTempRoot(root);
    }
  });

  it("explains how to seed the database when no WhatsApp messages exist", () => {
    const root = createTempRoot();
    const runtimeContext = createRuntimeContext(root);

    try {
      const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
      db.close();

      const stdout = createCapturedStdout();
      runWhatsAppIdsCli({
        stdout: stdout.stream,
        loadRuntimeContext: () => runtimeContext
      });

      expect(stdout.read()).toContain("No WhatsApp chats found yet.");
      expect(stdout.read()).toContain("Send the bot a WhatsApp DM or mention it in a group first");
    } finally {
      cleanupTempRoot(root);
    }
  });
});
