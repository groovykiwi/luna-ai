import { afterEach, describe, expect, it } from "vitest";

import { runDoctorCli } from "../src/bin/doctor.js";
import { cleanupTempRoot, createRuntimeContext, createTempRoot } from "./helpers.js";

function createCapturedStdout(): {
  stream: Pick<NodeJS.WriteStream, "write">;
  read: () => string;
} {
  let output = "";

  return {
    stream: {
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

describe("doctor cli", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      cleanupTempRoot(roots.pop()!);
    }
  });

  it("fails when OPENROUTER_API_KEY is missing", () => {
    const root = createTempRoot();
    roots.push(root);
    const stdout = createCapturedStdout();

    expect(() =>
      runDoctorCli({
        stdout: stdout.stream,
        loadEnvironment: () => ({
          openRouterApiKey: null,
          telegramBotToken: null,
          botPath: null
        }),
        loadRuntimeContext: () => createRuntimeContext(root),
        openDatabase: () => ({
          close() {}
        })
      })
    ).toThrow(/Doctor found 1 blocking issue/);

    expect(stdout.read()).toContain("[FAIL] OPENROUTER_API_KEY: missing");
  });

  it("passes on a whatsapp bot with a reachable database and no saved session", () => {
    const root = createTempRoot();
    roots.push(root);
    const stdout = createCapturedStdout();

    expect(() =>
      runDoctorCli({
        stdout: stdout.stream,
        loadEnvironment: () => ({
          openRouterApiKey: "key",
          telegramBotToken: null,
          botPath: null
        }),
        loadRuntimeContext: () => createRuntimeContext(root),
        openDatabase: () => ({
          close() {}
        })
      })
    ).not.toThrow();

    const output = stdout.read();
    expect(output).toContain("[PASS] OPENROUTER_API_KEY: present");
    expect(output).toContain("[WARN] WhatsApp auth: no saved session yet; run pnpm auth before first live run");
    expect(output).toContain("Doctor completed without blocking issues.");
  });
});
