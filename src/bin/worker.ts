import path from "node:path";

import { loadEnvironment } from "../config.js";
import { LunaDb } from "../db.js";
import { OpenRouterGateway } from "../llm.js";
import { createLogger } from "../logging.js";
import { loadRuntimeContext } from "../runtime.js";
import { BackgroundWorker } from "../worker.js";

async function main(): Promise<void> {
  const runtimeContext = loadRuntimeContext();
  const environment = loadEnvironment();
  if (!environment.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  const logger = createLogger(path.join(runtimeContext.paths.logsDir, "worker.log"), "worker");
  const db = new LunaDb(runtimeContext.paths.dbPath, runtimeContext.rootConfig.busyTimeoutMs);
  const gateway = new OpenRouterGateway(
    environment.openRouterApiKey,
    runtimeContext.rootConfig.openRouterBaseUrl,
    runtimeContext.botConfig.models,
    logger
  );
  const worker = new BackgroundWorker(runtimeContext, db, gateway, logger);

  process.on("SIGINT", () => {
    worker.stop();
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    worker.stop();
    db.close();
    process.exit(0);
  });

  await worker.start();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
