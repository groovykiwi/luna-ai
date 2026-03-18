import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvironment, type RuntimeEnvironment } from "../config.js";
import type { BotProvider, NormalizedMessage, RuntimeContext } from "../domain.js";
import { writeWhatsAppQr } from "../baileys.js";
import { createLogger, type Logger } from "../logging.js";
import { loadRuntimeContext } from "../runtime.js";
import { createTransport, type TransportFactoryOptions } from "../transports.js";

interface AuthTransport {
  start(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<{
    botJid: string;
    botIdentityJids: string[];
  }>;
  stop(): Promise<void>;
}

interface AuthCliDependencies {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  loadEnvironment?: () => RuntimeEnvironment;
  loadRuntimeContext?: () => RuntimeContext;
  createLogger?: typeof createLogger;
  createTransport?: (
    runtimeContext: RuntimeContext,
    environment: RuntimeEnvironment,
    logger: Logger,
    options?: TransportFactoryOptions
  ) => AuthTransport;
}

function parseArgs(argv: string[]): { demoWhatsApp: boolean; reset: boolean; help: boolean; provider: BotProvider | null } {
  let provider: BotProvider | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--provider") {
      const next = argv[index + 1];
      if (next === "whatsapp" || next === "telegram") {
        provider = next;
      } else {
        throw new Error("--provider must be followed by whatsapp or telegram.");
      }
    } else if (arg === "--provider=whatsapp") {
      provider = "whatsapp";
    } else if (arg === "--provider=telegram") {
      provider = "telegram";
    } else if (arg.startsWith("--provider=")) {
      throw new Error("--provider must be whatsapp or telegram.");
    }
  }

  return {
    demoWhatsApp: argv.includes("--demo-whatsapp"),
    reset: argv.includes("--reset") || argv.includes("--reinit"),
    help: argv.includes("--help") || argv.includes("-h"),
    provider
  };
}

function clearAuthDirectory(authDir: string): void {
  for (const entry of readdirSync(authDir)) {
    rmSync(path.join(authDir, entry), { recursive: true, force: true });
  }
}

function hasSavedSession(authDir: string): boolean {
  return readdirSync(authDir).length > 0;
}

function writeHelp(stdout: Pick<NodeJS.WriteStream, "write">): void {
  stdout.write("Usage: pnpm auth -- [--provider whatsapp|telegram] [--demo-whatsapp] [--reset|--reinit] [--help]\n");
  stdout.write("  --provider  Override bot.json provider for auth setup.\n");
  stdout.write("  --demo-whatsapp  Show a fake WhatsApp QR flow without touching auth files.\n");
  stdout.write("  --reset   Reset provider auth state before setup.\n");
  stdout.write("  --reinit  Alias for --reset.\n");
  stdout.write("  --help    Show this help text.\n");
}

async function runDemoFlow(botId: string, stdout: Pick<NodeJS.WriteStream, "write">): Promise<void> {
  stdout.write(`Starting WhatsApp auth demo for bot "${botId}".\n`);
  stdout.write("This simulates the QR flow without contacting WhatsApp or changing auth files.\n");
  writeWhatsAppQr(`LUNA-AUTH-DEMO:${botId}`, stdout);
  stdout.write("Demo complete. Re-run this command without --demo-whatsapp to perform a real login.\n");
}

export async function runAuthCli(dependencies: AuthCliDependencies = {}): Promise<void> {
  const argv = dependencies.argv ?? process.argv.slice(2);
  const stdout = dependencies.stdout ?? process.stdout;
  const environment = (dependencies.loadEnvironment ?? loadEnvironment)();
  const runtimeContext = (dependencies.loadRuntimeContext ?? loadRuntimeContext)();
  const loggerFactory = dependencies.createLogger ?? createLogger;
  const logger = loggerFactory(path.join(runtimeContext.paths.logsDir, "auth.log"), "auth");
  const createRuntimeTransport = dependencies.createTransport ?? createTransport;

  const { demoWhatsApp, reset, help, provider } = parseArgs(argv);
  if (help) {
    writeHelp(stdout);
    return;
  }

  const selectedProvider = provider ?? runtimeContext.botConfig.provider;

  if (selectedProvider === "telegram") {
    if (demoWhatsApp) {
      stdout.write("Telegram bots do not use QR auth. Ignoring --demo-whatsapp and validating TELEGRAM_BOT_TOKEN instead.\n");
    }
    if (reset) {
      stdout.write("Clearing Telegram webhook configuration and pending updates before validation.\n");
    }

    stdout.write(`Validating Telegram bot token for "${runtimeContext.botConfig.botId}".\n`);
    const transport = createRuntimeTransport(
      {
        ...runtimeContext,
        botConfig: {
          ...runtimeContext.botConfig,
          provider: "telegram"
        }
      },
      environment,
      logger,
      {
        telegram: {
          dropPendingUpdatesOnStart: reset
        }
      }
    );
    try {
      const { botJid } = await transport.start(async () => {});
      if (botJid) {
        stdout.write(`Telegram authentication completed for ${botJid}.\n`);
        return;
      }

      stdout.write("Telegram authentication completed.\n");
      return;
    } finally {
      await transport.stop().catch(() => {
        logger.warn("failed to stop auth transport cleanly");
      });
    }
  }

  if (demoWhatsApp) {
    await runDemoFlow(runtimeContext.botConfig.botId, stdout);
    return;
  }

  stdout.write(`Starting WhatsApp authentication for bot "${runtimeContext.botConfig.botId}".\n`);
  if (!stdout.isTTY) {
    stdout.write("No TTY detected. If the QR does not render, rerun this command in an interactive terminal.\n");
  }

  if (reset) {
    clearAuthDirectory(runtimeContext.paths.authDir);
    stdout.write("Cleared saved WhatsApp session files. A fresh QR login is required.\n");
  }

  const hasExistingSession = hasSavedSession(runtimeContext.paths.authDir);
  if (hasExistingSession) {
    stdout.write("Existing WhatsApp session detected. Use --reset or --reinit to force a fresh QR login.\n");
    stdout.write("This run will reuse the current saved session and exit after it connects.\n");
  } else {
    stdout.write("If a QR appears below, scan it in WhatsApp. This command exits once the session is linked.\n");
  }

  const transport = createRuntimeTransport(
    {
      ...runtimeContext,
      botConfig: {
        ...runtimeContext.botConfig,
        provider: "whatsapp"
      }
    },
    environment,
    logger
  );
  try {
    const { botJid } = await transport.start(async () => {});
    if (botJid) {
      stdout.write(`WhatsApp authentication completed for ${botJid}.\n`);
      return;
    }

    stdout.write("WhatsApp authentication completed.\n");
  } finally {
    await transport.stop().catch(() => {
      logger.warn("failed to stop auth transport cleanly");
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runAuthCli().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
