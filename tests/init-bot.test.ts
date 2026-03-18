import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempRoot, createTempRoot } from "./helpers.js";

describe("init-bot.sh", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        cleanupTempRoot(root);
      }
    }
  });

  it("uses the provided bot id for the scaffold botId and trigger name", () => {
    const root = createTempRoot();
    tempRoots.push(root);

    const botId = "orchid";
    const targetDir = path.join(root, botId);
    const scriptPath = path.resolve("scripts/init-bot.sh");

    execFileSync(scriptPath, [botId, targetDir], {
      cwd: path.resolve("."),
      stdio: "pipe"
    });

    const botConfig = JSON.parse(readFileSync(path.join(targetDir, "bot.json"), "utf8")) as {
      botId: string;
      triggerNames: string[];
    };

    expect(botConfig.botId).toBe(botId);
    expect(botConfig.triggerNames).toEqual([botId]);
  });
});
