import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoredMessage } from "../src/domain.js";
import { OpenRouterGateway } from "../src/llm.js";

const models = {
  main: "main-model",
  extract: "extract-model",
  vision: "vision-model",
  embed: "embed-model"
};

function makeStoredMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: overrides.id ?? 1,
    chatId: overrides.chatId ?? 1,
    blockId: overrides.blockId ?? 1,
    externalId: overrides.externalId ?? "msg-1",
    senderJid: overrides.senderJid ?? "user@s.whatsapp.net",
    senderName: overrides.senderName ?? "User",
    isFromBot: overrides.isFromBot ?? false,
    chatType: overrides.chatType ?? "dm",
    contextOnly: overrides.contextOnly ?? false,
    memoryEligible: overrides.memoryEligible ?? true,
    wasTriggered: overrides.wasTriggered ?? false,
    turnEligible: overrides.turnEligible ?? true,
    contentType: overrides.contentType ?? "text",
    text: overrides.text ?? "hello",
    imageDescription: overrides.imageDescription ?? null,
    quotedExternalId: overrides.quotedExternalId ?? null,
    mentions: overrides.mentions ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    processedTurnAt: overrides.processedTurnAt ?? null
  };
}

describe("openrouter gateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries transient chat completion failures before succeeding", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: {
            "content-type": "application/json"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "recovered"
                }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new OpenRouterGateway("test-key", "https://example.com", models, undefined, {
      timeoutMs: 1_000,
      maxRetries: 1,
      retryBaseDelayMs: 1
    });

    const result = await gateway.generateReply({
      persona: "You are a bot.",
      botId: "luna",
      messagePrefix: "",
      chatType: "dm",
      recentWindow: [],
      retrievedMemoryBlock: "",
      archiveFallbackBlock: "",
      pendingMessages: [],
      adminSenders: []
    });

    expect(result.reply).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps transport-owned prefixes out of the prompt and scrubs stored bot labels from history", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "all set"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new OpenRouterGateway("test-key", "https://example.com", models);

    await gateway.generateReply({
      persona: "You are Luna.",
      botId: "luna",
      messagePrefix: "🌙 ",
      chatType: "dm",
      recentWindow: [
        makeStoredMessage({
          isFromBot: true,
          senderJid: "bot@s.whatsapp.net",
          senderName: null,
          text: "🌙 luna: 🌙 lol sure"
        })
      ],
      retrievedMemoryBlock: "",
      archiveFallbackBlock: "",
      pendingMessages: [
        makeStoredMessage({
          id: 2,
          externalId: "msg-2",
          text: "what about alex?"
        })
      ],
      adminSenders: []
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();

    const body = JSON.parse(String(request?.body ?? "{}")) as {
      messages: Array<{ content: string }>;
    };

    expect(body.messages[0]?.content).toContain("The transport adds it after generation");
    expect(body.messages[0]?.content).toContain('Do not start the reply with "luna:"');
    expect(body.messages[1]?.content).toContain("luna: lol sure");
    expect(body.messages[1]?.content).not.toContain("luna: 🌙");
  });

  it("includes the provider response body in non-retryable errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid api key", raw: "provider rejected the token" } }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_123"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new OpenRouterGateway("bad-key", "https://example.com", models, undefined, {
      timeoutMs: 1_000,
      maxRetries: 0,
      retryBaseDelayMs: 1
    });

    await gateway.embedText("hello").catch((error: Error) => {
      expect(error.message).toMatch(/invalid api key/);
      expect(error.message).toMatch(/Request ID: req_123/);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
