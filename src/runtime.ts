import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { loadEnvironment, rootConfig } from "./config.js";
import type {
  BotFileConfig,
  BotReplyWhitelist,
  ResolvedBotConfig,
  ResolvedReplyWhitelist,
  RuntimeContext,
  RuntimePaths
} from "./domain.js";

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

function resolveBotConfig(rawConfig: BotFileConfig): ResolvedBotConfig {
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

  const botFileConfig = BotConfigSchema.parse(
    JSON.parse(readFileSync(paths.botConfigPath, "utf8"))
  ) as BotFileConfig;

  return {
    rootConfig,
    botConfig: resolveBotConfig(botFileConfig),
    persona,
    paths
  };
}
