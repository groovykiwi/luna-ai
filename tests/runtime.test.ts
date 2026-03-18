import { writeFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnvironment } from "../src/config.js";
import { loadRuntimeContext } from "../src/runtime.js";
import { cleanupTempRoot, createRuntimeContext, createTempRoot } from "./helpers.js";

function writeBotFiles(
  botPath: string,
  botConfig: Record<string, unknown>,
  heartbeat = "heartbeat instructions"
): void {
  writeFileSync(`${botPath}/persona.md`, "You are Maya.\n");
  writeFileSync(`${botPath}/heartbeat.md`, `${heartbeat}\n`);
  writeFileSync(`${botPath}/bot.json`, JSON.stringify(botConfig, null, 2));
}

describe("runtime config", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("defaults provider to whatsapp and uses the whatsapp config block", () => {
    const root = createTempRoot();
    roots.push(root);
    const runtime = createRuntimeContext(root);
    writeBotFiles(runtime.paths.botPath, {
      botId: "maya",
      triggerNames: ["maya"],
      whatsapp: {
        admins: [],
        replyWhitelist: {
          dms: ["123:1@s.whatsapp.net"]
        }
      }
    });

    vi.stubEnv("BOT_PATH", runtime.paths.botPath);

    const loaded = loadRuntimeContext();
    expect(loaded.botConfig.provider).toBe("whatsapp");
    expect(loaded.botConfig.replyWhitelist.dms).toEqual(["123@s.whatsapp.net"]);
  });

  it("keeps Telegram identifiers exact while trimming whitespace", () => {
    const root = createTempRoot();
    roots.push(root);
    const runtime = createRuntimeContext(root);
    writeBotFiles(runtime.paths.botPath, {
      botId: "maya",
      provider: "telegram",
      triggerNames: [],
      whatsapp: {
        admins: [" 123:1@s.whatsapp.net "],
        replyWhitelist: {
          dms: ["123:1@s.whatsapp.net"]
        }
      },
      telegram: {
        admins: [" tg:user:42 "],
        replyWhitelist: {
          dms: [" tg:chat:12345 "],
          groups: [" tg:chat:-100123 "]
        }
      }
    });

    vi.stubEnv("BOT_PATH", runtime.paths.botPath);

    const loaded = loadRuntimeContext();
    expect(loaded.botConfig.provider).toBe("telegram");
    expect(loaded.botConfig.admins).toEqual(["tg:user:42"]);
    expect(loaded.botConfig.replyWhitelist.dms).toEqual(["tg:chat:12345"]);
    expect(loaded.botConfig.replyWhitelist.groups).toEqual(["tg:chat:-100123"]);
  });

  it("loads the Telegram bot token from the environment", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:telegram-token");

    expect(loadEnvironment().telegramBotToken).toBe("123:telegram-token");
  });

  it("fails when the selected provider block is missing", () => {
    const root = createTempRoot();
    roots.push(root);
    const runtime = createRuntimeContext(root);
    writeBotFiles(runtime.paths.botPath, {
      botId: "maya",
      provider: "telegram",
      triggerNames: ["maya"],
      whatsapp: {
        admins: []
      }
    });

    vi.stubEnv("BOT_PATH", runtime.paths.botPath);

    expect(() => loadRuntimeContext()).toThrow('bot.json must define a "telegram" config block');
  });

  it("rejects shared runtime fields nested under a provider block", () => {
    const root = createTempRoot();
    roots.push(root);
    const runtime = createRuntimeContext(root);
    writeBotFiles(runtime.paths.botPath, {
      botId: "maya",
      provider: "telegram",
      triggerNames: ["maya"],
      telegram: {
        admins: [],
        heartbeat: {
          intervalMs: 1000
        }
      }
    });

    vi.stubEnv("BOT_PATH", runtime.paths.botPath);

    expect(() => loadRuntimeContext()).toThrow(/Unrecognized key\(s\) in object: 'heartbeat'/);
  });
});
