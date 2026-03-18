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

describe("heartbeat", () => {
  const roots: string[] = [];
  const runtimes: ChatRuntime[] = [];

  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()!.stop();
    }

    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("can proactively reply to ambient chatter on a random heartbeat interval", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.heartbeat = {
      enabled: true,
      intervalMs: null,
      randomIntervalMs: [5, 5],
      batchSize: 8
    };
    runtimeContext.heartbeatInstructions = "Check the chat and join only when there is something worth adding.";

    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    gateway.heartbeatResult = {
      shouldReply: true,
      reply: "Pizza night sounds strong.",
      memoryOperations: []
    };
    const transport = new MockTransport();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/heartbeat-random.log`, "heartbeat-random");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    runtimes.push(runtime);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "ambient-group-1",
        chatJid: "group@g.us",
        chatType: "group",
        senderJid: "user@s.whatsapp.net",
        senderName: "User",
        text: "we are planning pizza tonight"
      })
    );

    await waitFor(() => {
      expect(transport.sent).toHaveLength(1);
    });

    expect(transport.sent[0]).toEqual({
      chatJid: "group@g.us",
      text: "Pizza night sounds strong."
    });
    expect(gateway.replyInputs).toHaveLength(0);
    expect(gateway.heartbeatInputs).toHaveLength(1);
    expect(gateway.heartbeatInputs[0]?.reviewMessages.map((message) => message.externalId)).toEqual(["ambient-group-1"]);

    const chat = db.connection
      .prepare("SELECT last_reviewed_message_id AS lastReviewedMessageId FROM chats WHERE jid = ?")
      .get("group@g.us") as { lastReviewedMessageId: number | null };
    expect(chat.lastReviewedMessageId).not.toBeNull();
  });

  it("marks silent heartbeat reviews so the same ambient message is not rechecked every tick", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.heartbeat = {
      enabled: true,
      intervalMs: 5,
      randomIntervalMs: null,
      batchSize: 8
    };
    runtimeContext.heartbeatInstructions = "Only jump in when someone clearly needs Maya.";

    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    const transport = new MockTransport();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/heartbeat-silent.log`, "heartbeat-silent");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    runtimes.push(runtime);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "ambient-group-2",
        chatJid: "group@g.us",
        chatType: "group",
        senderJid: "user@s.whatsapp.net",
        senderName: "User",
        text: "just chatting here"
      })
    );

    await waitFor(() => {
      expect(gateway.heartbeatInputs).toHaveLength(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(transport.sent).toHaveLength(0);
    expect(gateway.heartbeatInputs).toHaveLength(1);
    expect(db.listChatsWithHeartbeatBacklog()).toEqual([]);
  });

  it("advances the review cursor after normal triggered turns so heartbeat does not revisit them", async () => {
    const root = createTempRoot();
    roots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.heartbeat = {
      enabled: true,
      intervalMs: 5,
      randomIntervalMs: null,
      batchSize: 8
    };
    runtimeContext.heartbeatInstructions = "Check for ambient conversations that Maya may want to join.";

    const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    const gateway = new FakeGateway();
    const transport = new MockTransport();
    const logger = createLogger(`${runtimeContext.paths.logsDir}/heartbeat-normal-turn.log`, "heartbeat-normal-turn");
    const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);
    runtimes.push(runtime);
    await runtime.start();

    await transport.push(
      makeIncomingMessage({
        externalId: "dm-trigger-1",
        chatJid: "user@s.whatsapp.net",
        senderJid: "user@s.whatsapp.net",
        text: "hello there"
      })
    );

    await waitFor(() => {
      expect(transport.sent).toHaveLength(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(gateway.replyInputs).toHaveLength(1);
    expect(gateway.heartbeatInputs).toHaveLength(0);
    expect(db.listChatsWithHeartbeatBacklog()).toEqual([]);
  });
});
