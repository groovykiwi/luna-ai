import { afterEach, describe, expect, it } from "vitest";

import { ChatRuntime } from "../src/chat/runtime.js";
import { LunaDb } from "../src/db.js";
import { createLogger } from "../src/logging.js";
import {
  cleanupTempRoot,
  createRuntimeContext,
  createTempRoot,
  FakeGateway,
  makeIncomingMessage,
  MockTransport,
  waitFor
} from "./helpers.js";

describe("reply allowlist", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("stores blocked DMs as archive-only and does not reply", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.replyWhitelist.dms = ["allowed@s.whatsapp.net"];

    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    const transport = new MockTransport();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/reply-whitelist-dm.log`, "reply-whitelist-dm");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "blocked-dm",
        chatJid: "blocked@s.whatsapp.net",
        senderJid: "blocked@s.whatsapp.net",
        text: "hello from blocked dm"
      })
    );

    expect(transport.sent).toHaveLength(0);
    const flags = db.connection
      .prepare(
        "SELECT context_only AS contextOnly, memory_eligible AS memoryEligible, turn_eligible AS turnEligible, was_triggered AS wasTriggered FROM messages WHERE external_id = 'blocked-dm'"
      )
      .get() as { contextOnly: number; memoryEligible: number; turnEligible: number; wasTriggered: number };

    expect(flags).toEqual({
      contextOnly: 1,
      memoryEligible: 0,
      turnEligible: 0,
      wasTriggered: 1
    });
  });

  it("replies only in allowlisted groups", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.replyWhitelist.groups = ["allowed@g.us"];

    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    const transport = new MockTransport();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/reply-whitelist-group.log`, "reply-whitelist-group");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "blocked-group",
        chatJid: "blocked@g.us",
        chatType: "group",
        senderJid: "user@s.whatsapp.net",
        mentions: ["bot@s.whatsapp.net"],
        text: "@bot are you there?"
      })
    );

    await transport.push(
      makeIncomingMessage({
        externalId: "allowed-group",
        chatJid: "allowed@g.us",
        chatType: "group",
        senderJid: "user@s.whatsapp.net",
        mentions: ["bot@s.whatsapp.net"],
        text: "@bot reply here"
      })
    );

    await waitFor(() => {
      expect(transport.sent).toHaveLength(1);
    });

    expect(transport.sent[0]).toEqual({
      chatJid: "allowed@g.us",
      text: "hi there"
    });

    const blockedFlags = db.connection
      .prepare(
        "SELECT context_only AS contextOnly, memory_eligible AS memoryEligible, turn_eligible AS turnEligible FROM messages WHERE external_id = 'blocked-group'"
      )
      .get() as { contextOnly: number; memoryEligible: number; turnEligible: number };
    const allowedFlags = db.connection
      .prepare(
        "SELECT context_only AS contextOnly, memory_eligible AS memoryEligible, turn_eligible AS turnEligible FROM messages WHERE external_id = 'allowed-group'"
      )
      .get() as { contextOnly: number; memoryEligible: number; turnEligible: number };

    expect(blockedFlags).toEqual({
      contextOnly: 1,
      memoryEligible: 0,
      turnEligible: 0
    });
    expect(allowedFlags).toEqual({
      contextOnly: 0,
      memoryEligible: 1,
      turnEligible: 1
    });
  });

  it("allows threaded Telegram DMs when the base chat ID is allowlisted", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.provider = "telegram";
    runtimeContext.botConfig.replyWhitelist.dms = ["tg:chat:12345"];

    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    const transport = new MockTransport("tg:user:42");
    const logger = createLogger(`${runtimeContext.paths.logsDir}/reply-whitelist-telegram.log`, "reply-whitelist-telegram");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "telegram-thread-dm",
        chatJid: "tg:chat:12345:thread:7",
        senderJid: "tg:user:99",
        text: "hello from a telegram topic"
      })
    );

    await waitFor(() => {
      expect(transport.sent).toHaveLength(1);
    });

    expect(transport.sent[0]).toEqual({
      chatJid: "tg:chat:12345:thread:7",
      text: "hi there"
    });

    const flags = db.connection
      .prepare(
        "SELECT context_only AS contextOnly, memory_eligible AS memoryEligible, turn_eligible AS turnEligible FROM messages WHERE external_id = 'telegram-thread-dm'"
      )
      .get() as { contextOnly: number; memoryEligible: number; turnEligible: number };

    expect(flags).toEqual({
      contextOnly: 0,
      memoryEligible: 1,
      turnEligible: 1
    });
  });
});
