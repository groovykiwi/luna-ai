import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { NormalizedMessage, RuntimeContext } from "../domain.js";
import { BaileysTransport, writeWhatsAppQr } from "../baileys.js";
import { createLogger, type Logger } from "../logging.js";
import { loadRuntimeContext } from "../runtime.js";

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
  loadRuntimeContext?: () => RuntimeContext;
  createLogger?: typeof createLogger;
  createTransport?: (authDir: string, logger: Logger) => AuthTransport;
}

function parseArgs(argv: string[]): { demo: boolean; reset: boolean; help: boolean } {
  return {
    demo: argv.includes("--demo"),
    reset: argv.includes("--reset") || argv.includes("--reinit"),
    help: argv.includes("--help") || argv.includes("-h")
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
  stdout.write("Usage: pnpm auth -- [--demo] [--reset|--reinit] [--help]\n");
  stdout.write("  --demo    Show a fake QR flow without touching auth files.\n");
  stdout.write("  --reset   Clear saved WhatsApp auth files and force a fresh login.\n");
  stdout.write("  --reinit  Alias for --reset.\n");
  stdout.write("  --help    Show this help text.\n");
}

async function runDemoFlow(botId: string, stdout: Pick<NodeJS.WriteStream, "write">): Promise<void> {
  stdout.write(`Starting WhatsApp auth demo for bot "${botId}".\n`);
  stdout.write("This simulates the QR flow without contacting WhatsApp or changing auth files.\n");
  writeWhatsAppQr(`LUNA-AUTH-DEMO:${botId}`, stdout);
  stdout.write("Demo complete. Re-run this command without --demo to perform a real login.\n");
}

export async function runAuthCli(dependencies: AuthCliDependencies = {}): Promise<void> {
  const argv = dependencies.argv ?? process.argv.slice(2);
  const stdout = dependencies.stdout ?? process.stdout;
  const runtimeContext = (dependencies.loadRuntimeContext ?? loadRuntimeContext)();
  const loggerFactory = dependencies.createLogger ?? createLogger;
  const logger = loggerFactory(path.join(runtimeContext.paths.logsDir, "auth.log"), "auth");
  const createTransport =
    dependencies.createTransport ?? ((authDir: string, transportLogger: Logger) => new BaileysTransport(authDir, transportLogger));

  const { demo, reset, help } = parseArgs(argv);
  if (help) {
    writeHelp(stdout);
    return;
  }

  if (demo) {
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

  const transport = createTransport(runtimeContext.paths.authDir, logger);
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
