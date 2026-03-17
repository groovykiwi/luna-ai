import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function emit(logFilePath: string, service: string, level: LogLevel, message: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service,
    message,
    ...(fields ?? {})
  });

  appendFileSync(logFilePath, `${line}\n`);
  // Docker logs still matter operationally, so mirror the same structured line to stdout/stderr.
  if (level === "error" || level === "warn") {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stdout.write(`${line}\n`);
}

export function createLogger(logFilePath: string, service: string): Logger {
  mkdirSync(path.dirname(logFilePath), { recursive: true });

  return {
    debug(message, fields) {
      emit(logFilePath, service, "debug", message, fields);
    },
    info(message, fields) {
      emit(logFilePath, service, "info", message, fields);
    },
    warn(message, fields) {
      emit(logFilePath, service, "warn", message, fields);
    },
    error(message, fields) {
      emit(logFilePath, service, "error", message, fields);
    }
  };
}
