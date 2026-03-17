import path from "node:path";

import { BaileysTransport } from "../baileys.js";
import { loadEnvironment } from "../config.js";
import { TinyClawDb } from "../db.js";
import { OpenRouterGateway } from "../llm.js";
import { createLogger } from "../logging.js";
import { loadRuntimeContext } from "../runtime.js";
import { ChatRuntime } from "../chat/runtime.js";

async function main(): Promise<void> {
  const runtimeContext = loadRuntimeContext();
  const environment = loadEnvironment();
  if (!environment.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  const logger = createLogger(path.join(runtimeContext.paths.logsDir, "chat.log"), "chat");
  const db = new TinyClawDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
  const gateway = new OpenRouterGateway(
    environment.openRouterApiKey,
    runtimeContext.rootConfig.openRouterBaseUrl,
    runtimeContext.botConfig.models,
    logger
  );
  const transport = new BaileysTransport(runtimeContext.paths.authDir, logger);
  const runtime = new ChatRuntime(runtimeContext, db, transport, gateway, logger);

  process.on("SIGINT", async () => {
    await runtime.stop();
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await runtime.stop();
    db.close();
    process.exit(0);
  });

  await runtime.start();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
