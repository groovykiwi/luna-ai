import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenRouterGateway } from "../src/llm.js";

const models = {
  main: "main-model",
  extract: "extract-model",
  vision: "vision-model",
  embed: "embed-model"
};

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
