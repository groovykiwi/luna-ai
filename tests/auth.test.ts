import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runAuthCli } from "../src/bin/auth.js";
import { cleanupTempRoot, createRuntimeContext, createTempRoot } from "./helpers.js";

function createEnvironment(overrides: Partial<{ openRouterApiKey: string | null; telegramBotToken: string | null; botPath: string | null }> = {}) {
  return {
    openRouterApiKey: null,
    telegramBotToken: null,
    botPath: null,
    ...overrides
  };
}

function createCapturedStdout(isTTY = true): {
  stream: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  read: () => string;
} {
  let output = "";

  return {
    stream: {
      isTTY,
      write(chunk: string | Uint8Array) {
        output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      }
    },
    read() {
      return output;
    }
  };
}

describe("auth cli", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        cleanupTempRoot(root);
      }
    }
  });

  it("runs a dummy demo flow without touching the transport", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const stdout = createCapturedStdout();
    const createTransport = vi.fn();

    await runAuthCli({
      argv: ["--demo-whatsapp"],
      stdout: stdout.stream,
      loadEnvironment: () => createEnvironment(),
      loadRuntimeContext: () => runtimeContext,
      createLogger: () => ({
        debug() {},
        info() {},
        warn() {},
        error() {}
      }),
      createTransport
    });

    expect(createTransport).not.toHaveBeenCalled();
    expect(stdout.read()).toContain('Starting WhatsApp auth demo for bot "maya".');
    expect(stdout.read()).toContain("Demo complete. Re-run this command without --demo-whatsapp to perform a real login.");
    expect(readdirSync(runtimeContext.paths.authDir)).toEqual([]);
  });

  it("clears auth state and completes the real auth flow", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const staleAuthFile = path.join(runtimeContext.paths.authDir, "creds.json");
    writeFileSync(staleAuthFile, "{\"stale\":true}\n");

    const stdout = createCapturedStdout(false);
    const start = vi.fn(async () => ({
      botJid: "bot@s.whatsapp.net",
      botIdentityJids: ["bot@s.whatsapp.net"]
    }));
    const stop = vi.fn(async () => {});

    await runAuthCli({
      argv: ["--reinit"],
      stdout: stdout.stream,
      loadEnvironment: () => createEnvironment(),
      loadRuntimeContext: () => runtimeContext,
      createLogger: () => ({
        debug() {},
        info() {},
        warn() {},
        error() {}
      }),
      createTransport: () => ({
        start,
        stop
      })
    });

    expect(readdirSync(runtimeContext.paths.authDir)).toEqual([]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stdout.read()).toContain("No TTY detected.");
    expect(stdout.read()).toContain("Cleared saved WhatsApp session files. A fresh QR login is required.");
    expect(stdout.read()).toContain("WhatsApp authentication completed for bot@s.whatsapp.net.");
  });

  it("warns when it is reusing an existing saved session", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const runtimeContext = createRuntimeContext(root);
    writeFileSync(path.join(runtimeContext.paths.authDir, "creds.json"), "{\"active\":true}\n");

    const stdout = createCapturedStdout();
    const start = vi.fn(async () => ({
      botJid: "bot@s.whatsapp.net",
      botIdentityJids: ["bot@s.whatsapp.net"]
    }));
    const stop = vi.fn(async () => {});

    await runAuthCli({
      argv: [],
      stdout: stdout.stream,
      loadEnvironment: () => createEnvironment(),
      loadRuntimeContext: () => runtimeContext,
      createLogger: () => ({
        debug() {},
        info() {},
        warn() {},
        error() {}
      }),
      createTransport: () => ({
        start,
        stop
      })
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stdout.read()).toContain("Existing WhatsApp session detected. Use --reset or --reinit to force a fresh QR login.");
    expect(stdout.read()).toContain("This run will reuse the current saved session and exit after it connects.");
  });

  it("prints help text", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const runtimeContext = createRuntimeContext(root);
    const stdout = createCapturedStdout();

    await runAuthCli({
      argv: ["--help"],
      stdout: stdout.stream,
      loadEnvironment: () => createEnvironment(),
      loadRuntimeContext: () => runtimeContext,
      createLogger: () => ({
        debug() {},
        info() {},
        warn() {},
        error() {}
      }),
      createTransport: vi.fn()
    });

    expect(stdout.read()).toContain("Usage: pnpm auth -- [--provider whatsapp|telegram] [--demo-whatsapp] [--reset|--reinit] [--help]");
    expect(stdout.read()).toContain("--provider  Override bot.json provider for auth setup.");
    expect(stdout.read()).toContain("--demo-whatsapp  Show a fake WhatsApp QR flow without touching auth files.");
    expect(stdout.read()).toContain("--reinit  Alias for --reset.");
  });

  it("validates Telegram auth through the provider transport", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.provider = "telegram";
    const stdout = createCapturedStdout();
    const start = vi.fn(async () => ({
      botJid: "tg:user:42",
      botIdentityJids: ["tg:user:42"]
    }));
    const stop = vi.fn(async () => {});

    await runAuthCli({
      argv: ["--demo-whatsapp", "--reset"],
      stdout: stdout.stream,
      loadEnvironment: () => createEnvironment({ telegramBotToken: "123:telegram-token" }),
      loadRuntimeContext: () => runtimeContext,
      createLogger: () => ({
        debug() {},
        info() {},
        warn() {},
        error() {}
      }),
      createTransport: (_context, _environment, _logger, options) => {
        expect(options).toEqual({
          telegram: {
            dropPendingUpdatesOnStart: true
          }
        });
        return {
          start,
          stop
        };
      }
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stdout.read()).toContain("Telegram bots do not use QR auth. Ignoring --demo-whatsapp");
    expect(stdout.read()).toContain("Clearing Telegram webhook configuration and pending updates before validation.");
    expect(stdout.read()).toContain('Validating Telegram bot token for "maya".');
    expect(stdout.read()).toContain("Telegram authentication completed for tg:user:42.");
  });

  it("allows Telegram auth setup even when bot.json currently selects WhatsApp", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const runtimeContext = createRuntimeContext(root);
    runtimeContext.botConfig.provider = "whatsapp";
    const stdout = createCapturedStdout();
    const start = vi.fn(async () => ({
      botJid: "tg:user:42",
      botIdentityJids: ["tg:user:42"]
    }));
    const stop = vi.fn(async () => {});

    await runAuthCli({
      argv: ["--provider", "telegram"],
      stdout: stdout.stream,
      loadEnvironment: () => createEnvironment({ telegramBotToken: "123:telegram-token" }),
      loadRuntimeContext: () => runtimeContext,
      createLogger: () => ({
        debug() {},
        info() {},
        warn() {},
        error() {}
      }),
      createTransport: (context) => {
        expect(context.botConfig.provider).toBe("telegram");
        return {
          start,
          stop
        };
      }
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stdout.read()).toContain("Telegram authentication completed for tg:user:42.");
  });
});
