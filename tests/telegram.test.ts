import { afterEach, describe, expect, it } from "vitest";

import type { Logger } from "../src/logging.js";
import { TelegramTransport } from "../src/telegram.js";
import { waitFor } from "./helpers.js";

function createLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

function jsonResponse(result: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function createFetchMock(
  responsesByMethod: Partial<Record<string, Array<unknown | Response>>>
): {
  calls: Array<{ method: string; body: unknown }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ method: string; body: unknown }> = [];
  const queues = new Map<string, Array<unknown | Response>>();
  for (const [method, responses] of Object.entries(responsesByMethod)) {
    if (responses) {
      queues.set(method, [...responses]);
    }
  }

  const fetchImpl: typeof fetch = async (_input, init) => {
    const url = String(_input);
    const method = url.split("/").pop() ?? "";
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) : null;
    calls.push({ method, body });

    const queue = queues.get(method);
    const next = queue?.shift();
    if (next instanceof Response) {
      return next;
    }
    if (next !== undefined) {
      return jsonResponse(next);
    }

    if (method === "getUpdates") {
      return await new Promise<Response>((_, reject) => {
        if (init?.signal?.aborted) {
          reject(createAbortError());
          return;
        }

        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(createAbortError());
          },
          { once: true }
        );
      });
    }

    return jsonResponse(true);
  };

  return {
    calls,
    fetchImpl
  };
}

describe("TelegramTransport", () => {
  const transports: TelegramTransport[] = [];

  afterEach(async () => {
    while (transports.length > 0) {
      await transports.pop()!.stop();
    }
  });

  it("normalizes inbound private text messages and advances the polling offset", async () => {
    const { fetchImpl, calls } = createFetchMock({
      getMe: [{ id: 42, is_bot: true, username: "maya_bot" }],
      deleteWebhook: [true],
      getUpdates: [
        [
          {
            update_id: 100,
            message: {
              message_id: 7,
              date: 1_710_000_000,
              chat: { id: 555, type: "private" },
              from: { id: 99, is_bot: false, first_name: "Nate" },
              text: "hello there",
              reply_to_message: { message_id: 3 }
            }
          }
        ],
        []
      ]
    });

    const received: Array<{ chatJid: string; senderJid: string; externalId: string; quotedExternalId: string | null; text: string | null }> = [];
    const transport = new TelegramTransport("token", createLogger(), {
      fetchImpl,
      retryDelayMs: 1
    });
    transports.push(transport);

    const started = await transport.start(async (message) => {
      received.push({
        chatJid: message.chatJid,
        senderJid: message.senderJid,
        externalId: message.externalId,
        quotedExternalId: message.quotedExternalId,
        text: message.text
      });
    });

    expect(started).toEqual({
      botJid: "tg:user:42",
      botIdentityJids: ["tg:user:42"]
    });

    await waitFor(() => {
      expect(received).toEqual([
        {
          chatJid: "tg:chat:555",
          senderJid: "tg:user:99",
          externalId: "tg:msg:555:7",
          quotedExternalId: "tg:msg:555:3",
          text: "hello there"
        }
      ]);
    });

    await waitFor(() => {
      const deleteWebhookCalls = calls.filter((call) => call.method === "deleteWebhook");
      expect(deleteWebhookCalls).toEqual([
        {
          method: "deleteWebhook",
          body: {
            drop_pending_updates: false
          }
        }
      ]);

      const getUpdatesCalls = calls.filter((call) => call.method === "getUpdates");
      expect(getUpdatesCalls.length).toBeGreaterThanOrEqual(2);
      expect(getUpdatesCalls[0]?.body).toMatchObject({
        timeout: 30,
        allowed_updates: ["message"]
      });
      expect(getUpdatesCalls[1]?.body).toMatchObject({
        offset: 101
      });
    });
  });

  it("can drop pending updates when reset is requested", async () => {
    const { fetchImpl, calls } = createFetchMock({
      getMe: [{ id: 42, is_bot: true, username: "maya_bot" }],
      deleteWebhook: [true]
    });

    const transport = new TelegramTransport("token", createLogger(), {
      fetchImpl,
      retryDelayMs: 1,
      dropPendingUpdatesOnStart: true
    });
    transports.push(transport);

    await transport.start(async () => {});

    expect(calls.filter((call) => call.method === "deleteWebhook")).toEqual([
      {
        method: "deleteWebhook",
        body: {
          drop_pending_updates: true
        }
      }
    ]);
  });

  it("retries the same update until it is handled before advancing the polling offset", async () => {
    const { fetchImpl, calls } = createFetchMock({
      getMe: [{ id: 42, is_bot: true, username: "maya_bot" }],
      deleteWebhook: [true],
      getUpdates: [
        [
          {
            update_id: 300,
            message: {
              message_id: 9,
              date: 1_710_000_004,
              chat: { id: 555, type: "private" },
              from: { id: 99, is_bot: false, first_name: "Nate" },
              text: "retry me"
            }
          }
        ],
        [
          {
            update_id: 300,
            message: {
              message_id: 9,
              date: 1_710_000_004,
              chat: { id: 555, type: "private" },
              from: { id: 99, is_bot: false, first_name: "Nate" },
              text: "retry me"
            }
          }
        ],
        []
      ]
    });

    let attempts = 0;
    const received: string[] = [];
    const transport = new TelegramTransport("token", createLogger(), {
      fetchImpl,
      retryDelayMs: 1
    });
    transports.push(transport);

    await transport.start(async (message) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ingest failed");
      }

      received.push(message.externalId);
    });

    await waitFor(() => {
      expect(received).toEqual(["tg:msg:555:9"]);
      const getUpdatesCalls = calls.filter((call) => call.method === "getUpdates");
      expect(getUpdatesCalls[0]?.body).not.toHaveProperty("offset");
      expect(getUpdatesCalls[1]?.body).not.toHaveProperty("offset");
      expect(getUpdatesCalls[2]?.body).toMatchObject({
        offset: 301
      });
    });
  });

  it("ignores non-private and non-text Telegram messages", async () => {
    const { fetchImpl } = createFetchMock({
      getMe: [{ id: 42, is_bot: true, username: "maya_bot" }],
      deleteWebhook: [true],
      getUpdates: [
        [
          {
            update_id: 200,
            message: {
              message_id: 1,
              date: 1_710_000_001,
              chat: { id: -100, type: "group" },
              from: { id: 99, is_bot: false, first_name: "Nate" },
              text: "hello group"
            }
          },
          {
            update_id: 201,
            message: {
              message_id: 2,
              date: 1_710_000_002,
              chat: { id: 555, type: "private" },
              from: { id: 99, is_bot: false, first_name: "Nate" }
            }
          }
        ]
      ]
    });

    const received: string[] = [];
    const transport = new TelegramTransport("token", createLogger(), {
      fetchImpl,
      retryDelayMs: 1
    });
    transports.push(transport);

    await transport.start(async (message) => {
      received.push(message.externalId);
    });

    await waitFor(() => {
      expect(received).toEqual([]);
    });
  });

  it("keeps Telegram thread context on inbound and outbound messages", async () => {
    const { fetchImpl, calls } = createFetchMock({
      getMe: [{ id: 42, is_bot: true, username: "maya_bot" }],
      deleteWebhook: [true],
      getUpdates: [
        [
          {
            update_id: 400,
            message: {
              message_id: 12,
              date: 1_710_000_005,
              chat: { id: 555, type: "private" },
              from: { id: 99, is_bot: false, first_name: "Nate" },
              message_thread_id: 77,
              text: "hello from a topic"
            }
          }
        ],
        []
      ],
      sendChatAction: [true],
      sendMessage: [
        {
          message_id: 13,
          date: 1_710_000_006,
          chat: { id: 555, type: "private" }
        }
      ]
    });

    const received: Array<{ chatJid: string; text: string | null }> = [];
    const transport = new TelegramTransport("token", createLogger(), {
      fetchImpl,
      retryDelayMs: 1
    });
    transports.push(transport);

    await transport.start(async (message) => {
      received.push({
        chatJid: message.chatJid,
        text: message.text
      });
    });

    await waitFor(() => {
      expect(received).toEqual([
        {
          chatJid: "tg:chat:555:thread:77",
          text: "hello from a topic"
        }
      ]);
    });

    await transport.updatePresence("tg:chat:555:thread:77", "composing");
    await transport.sendText("tg:chat:555:thread:77", "reply in topic");

    expect(calls.filter((call) => call.method === "sendChatAction")).toEqual([
      {
        method: "sendChatAction",
        body: {
          chat_id: "555",
          action: "typing",
          message_thread_id: 77
        }
      }
    ]);
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([
      {
        method: "sendMessage",
        body: {
          chat_id: "555",
          text: "reply in topic",
          message_thread_id: 77
        }
      }
    ]);
  });

  it("sends typing actions and outbound text through the Bot API", async () => {
    const { fetchImpl, calls } = createFetchMock({
      getMe: [{ id: 42, is_bot: true, username: "maya_bot" }],
      deleteWebhook: [true],
      sendChatAction: [true],
      sendMessage: [
        {
          message_id: 11,
          date: 1_710_000_003,
          chat: { id: 555, type: "private" }
        }
      ]
    });

    const transport = new TelegramTransport("token", createLogger(), {
      fetchImpl,
      retryDelayMs: 1
    });
    transports.push(transport);

    await transport.start(async () => {});
    await transport.updatePresence("tg:chat:555", "composing");
    await transport.updatePresence("tg:chat:555", "paused");
    const sent = await transport.sendText("tg:chat:555", "hi there");

    expect(sent).toEqual({
      externalId: "tg:msg:555:11",
      timestamp: new Date(1_710_000_003 * 1000).toISOString()
    });

    expect(calls.filter((call) => call.method === "sendChatAction")).toEqual([
      {
        method: "sendChatAction",
        body: {
          chat_id: "555",
          action: "typing"
        }
      }
    ]);
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([
      {
        method: "sendMessage",
        body: {
          chat_id: "555",
          text: "hi there"
        }
      }
    ]);
  });
});
