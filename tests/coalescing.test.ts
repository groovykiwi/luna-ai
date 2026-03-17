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

describe("turn coalescing", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("coalesces multiple inbound messages from the same chat before reply generation starts", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    const transport = new MockTransport();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/chat-test.log`, "chat-test");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "dm-1",
        text: "first",
        chatJid: "user@s.whatsapp.net",
        senderJid: "user@s.whatsapp.net"
      })
    );
    await transport.push(
      makeIncomingMessage({
        externalId: "dm-2",
        text: "second",
        chatJid: "user@s.whatsapp.net",
        senderJid: "user@s.whatsapp.net"
      })
    );

    await waitFor(() => {
      expect(transport.sent).toHaveLength(1);
    });

    expect(gateway.replyInputs).toHaveLength(1);
    expect(gateway.replyInputs[0]?.pendingMessages).toHaveLength(2);
    expect(transport.presenceUpdates).toEqual([
      { chatJid: "user@s.whatsapp.net", state: "composing" },
      { chatJid: "user@s.whatsapp.net", state: "paused" }
    ]);

    const processedCount = db.connection
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE processed_turn_at IS NOT NULL")
      .get() as { count: number };
    expect(processedCount.count).toBe(2);
  });

  it("keeps prior context separate from the current turn", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    const transport = new MockTransport();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/chat-context-test.log`, "chat-context-test");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "group-ambient",
        chatJid: "group@g.us",
        chatType: "group",
        senderJid: "user-1@s.whatsapp.net",
        senderName: "Ambient User",
        text: "this is background chatter"
      })
    );

    await transport.push(
      makeIncomingMessage({
        externalId: "group-trigger",
        chatJid: "group@g.us",
        chatType: "group",
        senderJid: "user-2@s.whatsapp.net",
        senderName: "Trigger User",
        mentions: ["bot@s.whatsapp.net"],
        text: "@bot answer this"
      })
    );

    await waitFor(() => {
      expect(transport.sent).toHaveLength(1);
    });

    expect(gateway.replyInputs).toHaveLength(1);
    expect(gateway.replyInputs[0]?.recentWindow.map((message) => message.externalId)).toEqual(["group-ambient"]);
    expect(gateway.replyInputs[0]?.pendingMessages.map((message) => message.externalId)).toEqual(["group-trigger"]);
  });

  it("applies the configured message prefix to each outbound bubble", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.messagePrefix = "[Maya] ";
    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    gateway.replyResult = {
      reply: "first bubble\n\nsecond bubble",
      memoryOperations: []
    };
    const transport = new MockTransport();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/chat-prefix-test.log`, "chat-prefix-test");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "dm-prefix-1",
        text: "hello",
        chatJid: "user@s.whatsapp.net",
        senderJid: "user@s.whatsapp.net"
      })
    );

    await waitFor(() => {
      expect(transport.sent).toHaveLength(2);
    });

    expect(transport.sent.map((message) => message.text)).toEqual([
      "[Maya] first bubble",
      "[Maya] second bubble"
    ]);
  });

});
