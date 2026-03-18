import "dotenv/config";

import { z } from "zod";

import type { RootConfig } from "./domain.js";

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().min(1).optional());

const EnvironmentSchema = z.object({
  OPENROUTER_API_KEY: optionalNonEmptyString,
  TELEGRAM_BOT_TOKEN: optionalNonEmptyString,
  OPENROUTER_BASE_URL: z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }, z.string().url().optional()),
  BOT_PATH: optionalNonEmptyString
});

export interface RuntimeEnvironment {
  openRouterApiKey: string | null;
  telegramBotToken: string | null;
  botPath: string | null;
}

export const rootConfig: RootConfig = {
  openRouterBaseUrl: "https://openrouter.ai/api/v1",
  models: {
    main: "anthropic/claude-sonnet-4.6",
    extract: "openai/gpt-4o-mini",
    vision: "openai/gpt-4o-mini",
    embed: "openai/text-embedding-3-small"
  },
  defaultBlockSize: 50,
  defaultBubbleDelayMs: [800, 2000],
  defaultRetrievalMinHits: 3,
  defaultHeartbeatBatchSize: 8,
  memorySearchLimit: 5,
  memorySearchCandidateLimit: 512,
  rawArchiveSearchLimit: 5,
  recentWindowBlockLimit: 2,
  recentWindowMessageLimit: 24,
  busyTimeoutMs: 5000,
  workerPollIntervalMs: 2500,
  staleJobAfterMs: 10 * 60 * 1000,
  bubbleTypingBaseMs: 275,
  inlineForgetSearchLimit: 5,
  openRouterRequestTimeoutMs: 20_000,
  openRouterMaxRetries: 2,
  openRouterRetryBaseDelayMs: 500
};

export function loadEnvironment(): RuntimeEnvironment {
  const parsed = EnvironmentSchema.parse(process.env);
  return {
    openRouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN ?? null,
    botPath: parsed.BOT_PATH ?? null
  };
}
