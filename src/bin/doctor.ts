import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadEnvironment, type RuntimeEnvironment } from "../config.js";
import { LunaDb, LunaDbOpenError } from "../db.js";
import type { RuntimeContext } from "../domain.js";
import { loadRuntimeContext } from "../runtime.js";

type CheckLevel = "PASS" | "WARN" | "FAIL";

interface DoctorCliDependencies {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  loadEnvironment?: () => RuntimeEnvironment;
  loadRuntimeContext?: () => RuntimeContext;
  openDatabase?: (dbPath: string, busyTimeoutMs: number) => Pick<LunaDb, "close">;
}

function printHelp(stdout: Pick<NodeJS.WriteStream, "write">): void {
  stdout.write("Usage: pnpm doctor -- [--help]\n");
  stdout.write("Runs a local preflight check for env vars, auth prerequisites, and SQLite access.\n");
}

function parseArgs(argv: string[]): { help: boolean } {
  let help = false;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help };
}

function writeCheck(
  stdout: Pick<NodeJS.WriteStream, "write">,
  level: CheckLevel,
  label: string,
  message: string
): void {
  stdout.write(`[${level}] ${label}: ${message}\n`);
}

export function runDoctorCli(dependencies: DoctorCliDependencies = {}): void {
  const argv = dependencies.argv ?? process.argv.slice(2);
  const stdout = dependencies.stdout ?? process.stdout;
  const { help } = parseArgs(argv);
  if (help) {
    printHelp(stdout);
    return;
  }

  const environment = (dependencies.loadEnvironment ?? loadEnvironment)();
  const runtimeContext = (dependencies.loadRuntimeContext ?? loadRuntimeContext)();
  const openDatabase = dependencies.openDatabase ?? ((dbPath: string, busyTimeoutMs: number) => new LunaDb(dbPath, busyTimeoutMs));
  let failureCount = 0;

  writeCheck(stdout, "PASS", "Bot path", runtimeContext.paths.botPath);
  writeCheck(stdout, "PASS", "Provider", runtimeContext.botConfig.provider);

  if (environment.openRouterApiKey) {
    writeCheck(stdout, "PASS", "OPENROUTER_API_KEY", "present");
  } else {
    failureCount += 1;
    writeCheck(stdout, "FAIL", "OPENROUTER_API_KEY", "missing");
  }

  if (runtimeContext.botConfig.provider === "telegram") {
    if (environment.telegramBotToken) {
      writeCheck(stdout, "PASS", "TELEGRAM_BOT_TOKEN", "present");
    } else {
      failureCount += 1;
      writeCheck(stdout, "FAIL", "TELEGRAM_BOT_TOKEN", "required for Telegram bots");
    }
  } else {
    const sessionEntries = readdirSync(runtimeContext.paths.authDir);
    if (sessionEntries.length > 0) {
      writeCheck(stdout, "PASS", "WhatsApp auth", `found ${sessionEntries.length} auth file(s)`);
    } else {
      writeCheck(stdout, "WARN", "WhatsApp auth", "no saved session yet; run pnpm auth before first live run");
    }
  }

  try {
    const db = openDatabase(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
    db.close();
    writeCheck(stdout, "PASS", "SQLite", `opened ${runtimeContext.paths.dbPath}`);
  } catch (error) {
    failureCount += 1;
    const message = error instanceof LunaDbOpenError ? error.message : error instanceof Error ? error.message : String(error);
    writeCheck(stdout, "FAIL", "SQLite", message);
  }

  if (failureCount > 0) {
    throw new Error(`Doctor found ${failureCount} blocking issue(s).`);
  }

  stdout.write("Doctor completed without blocking issues.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runDoctorCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
