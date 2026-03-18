import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { loadEnvironment, rootConfig } from "./config.js";
import type {
  BotHeartbeatConfig,
  BotFileConfig,
  BotReplyWhitelist,
  ResolvedBotConfig,
  ResolvedHeartbeatConfig,
  ResolvedReplyWhitelist,
  RuntimeContext,
  RuntimePaths
} from "./domain.js";

const HeartbeatConfigSchema = z
  .object({
    intervalMs: z.number().int().positive().optional(),
    randomIntervalMs: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    batchSize: z.number().int().positive().optional()
  })
  .superRefine((value, ctx) => {
    const scheduleCount = Number(value.intervalMs !== undefined) + Number(value.randomIntervalMs !== undefined);
    if (scheduleCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "heartbeat must set exactly one of intervalMs or randomIntervalMs"
      });
    }

    if (value.randomIntervalMs && value.randomIntervalMs[0] > value.randomIntervalMs[1]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "heartbeat.randomIntervalMs must be ordered as [min, max]"
      });
    }
  });

const BotConfigSchema = z.object({
  botId: z.string().min(1),
  triggerNames: z.array(z.string().min(1)).default([]),
  admins: z.array(z.string().min(1)).default([]),
  messagePrefix: z.string().optional(),
  replyWhitelist: z
    .object({
      dms: z.array(z.string().min(1)).optional(),
      groups: z.array(z.string().min(1)).optional()
    })
    .optional(),
  heartbeat: HeartbeatConfigSchema.optional(),
  blockSize: z.number().int().positive().optional(),
  bubbleDelayMs: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  retrievalMinHits: z.number().int().positive().optional(),
  models: z
    .object({
      main: z.string().min(1).nullable().optional(),
      extract: z.string().min(1).nullable().optional(),
      vision: z.string().min(1).nullable().optional(),
      embed: z.string().min(1).nullable().optional()
    })
    .optional(),
  retainProcessedMedia: z.boolean().optional()
});

function resolveBotPath(explicitBotPath: string | null): string {
  if (explicitBotPath) {
    return path.resolve(explicitBotPath);
  }

  const cwd = process.cwd();
  if (hasRequiredBotFiles(cwd)) {
    return cwd;
  }

  const botsDir = path.join(cwd, "bots");
  try {
    const candidates = readdirSync(botsDir)
      .map((entry) => path.join(botsDir, entry))
      .filter((entry) => statSync(entry).isDirectory() && hasRequiredBotFiles(entry));

    if (candidates.length === 1) {
      const [candidate] = candidates;
      if (candidate) {
        return candidate;
      }
    }
  } catch {
    // Intentional no-op: a missing bots dir just means there is nothing to auto-detect.
  }

  throw new Error(
    "Unable to resolve bot folder. Set BOT_PATH or run inside a folder that contains persona.md and bot.json."
  );
}

function hasRequiredBotFiles(botPath: string): boolean {
  try {
    return statSync(path.join(botPath, "persona.md")).isFile() && statSync(path.join(botPath, "bot.json")).isFile();
  } catch {
    return false;
  }
}

function normalizeWhatsAppJid(value: string): string {
  const trimmed = value.trim();
  const [localPart, domain] = trimmed.split("@");
  if (!localPart || !domain) {
    return trimmed;
  }

  return `${localPart.split(":")[0]}@${domain}`;
}

function resolveWhitelistEntries(entries: string[] | undefined): string[] | null {
  if (entries === undefined) {
    return null;
  }

  return [...new Set(entries.map((value) => normalizeWhatsAppJid(value)).filter(Boolean))];
}

function resolveReplyWhitelist(replyWhitelist: BotReplyWhitelist | undefined): ResolvedReplyWhitelist {
  return {
    // Null means unrestricted for that chat type; an empty array means deny all.
    dms: resolveWhitelistEntries(replyWhitelist?.dms),
    groups: resolveWhitelistEntries(replyWhitelist?.groups)
  };
}

function resolveHeartbeatConfig(
  heartbeatConfig: BotHeartbeatConfig | undefined,
  heartbeatInstructions: string | null
): ResolvedHeartbeatConfig {
  if (!heartbeatConfig) {
    return {
      enabled: false,
      intervalMs: null,
      randomIntervalMs: null,
      batchSize: rootConfig.defaultHeartbeatBatchSize
    };
  }

  if (!heartbeatInstructions) {
    throw new Error("heartbeat.md must exist and be non-empty when heartbeat is configured.");
  }

  return {
    enabled: true,
    intervalMs: heartbeatConfig.intervalMs ?? null,
    randomIntervalMs: heartbeatConfig.randomIntervalMs ?? null,
    batchSize: heartbeatConfig.batchSize ?? rootConfig.defaultHeartbeatBatchSize
  };
}

function resolveBotConfig(rawConfig: BotFileConfig, heartbeatInstructions: string | null): ResolvedBotConfig {
  const bubbleDelayMs = rawConfig.bubbleDelayMs ?? [...rootConfig.defaultBubbleDelayMs];
  if (bubbleDelayMs[0] > bubbleDelayMs[1]) {
    throw new Error("bubbleDelayMs must be ordered as [min, max].");
  }

  return {
    botId: rawConfig.botId,
    triggerNames: rawConfig.triggerNames.map((value) => value.trim()).filter(Boolean),
    admins: [...new Set(rawConfig.admins)],
    messagePrefix: rawConfig.messagePrefix ?? "",
    replyWhitelist: resolveReplyWhitelist(rawConfig.replyWhitelist),
    heartbeat: resolveHeartbeatConfig(rawConfig.heartbeat, heartbeatInstructions),
    blockSize: rawConfig.blockSize ?? rootConfig.defaultBlockSize,
    bubbleDelayMs,
    retrievalMinHits: rawConfig.retrievalMinHits ?? rootConfig.defaultRetrievalMinHits,
    models: {
      main: rawConfig.models?.main ?? rootConfig.models.main,
      extract: rawConfig.models?.extract ?? rootConfig.models.extract,
      vision: rawConfig.models?.vision ?? rootConfig.models.vision,
      embed: rawConfig.models?.embed ?? rootConfig.models.embed
    },
    retainProcessedMedia: rawConfig.retainProcessedMedia ?? false
  };
}

export function loadRuntimeContext(): RuntimeContext {
  const environment = loadEnvironment();
  const botPath = resolveBotPath(environment.botPath);
  const paths: RuntimePaths = {
    botPath,
    personaPath: path.join(botPath, "persona.md"),
    botConfigPath: path.join(botPath, "bot.json"),
    heartbeatPath: path.join(botPath, "heartbeat.md"),
    dbPath: path.join(botPath, "bot.db"),
    authDir: path.join(botPath, "auth"),
    mediaDir: path.join(botPath, "media"),
    logsDir: path.join(botPath, "logs")
  };

  mkdirSync(paths.authDir, { recursive: true });
  mkdirSync(paths.mediaDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  const persona = readFileSync(paths.personaPath, "utf8").trim();
  if (!persona) {
    throw new Error("persona.md must not be empty.");
  }

  let heartbeatInstructions: string | null = null;
  try {
    if (statSync(paths.heartbeatPath).isFile()) {
      const resolved = readFileSync(paths.heartbeatPath, "utf8").trim();
      heartbeatInstructions = resolved || null;
    }
  } catch {
    heartbeatInstructions = null;
  }

  const botFileConfig = BotConfigSchema.parse(
    JSON.parse(readFileSync(paths.botConfigPath, "utf8"))
  ) as BotFileConfig;

  return {
    rootConfig,
    botConfig: resolveBotConfig(botFileConfig, heartbeatInstructions),
    persona,
    heartbeatInstructions,
    paths
  };
}
