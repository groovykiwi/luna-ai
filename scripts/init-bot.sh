#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: ./scripts/init-bot.sh <bot-id> [target-dir]" >&2
  exit 1
fi

BOT_ID="$1"
TARGET_DIR="${2:-bots/$BOT_ID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$TARGET_DIR" = /* ]]; then
  TARGET_PATH="$TARGET_DIR"
else
  TARGET_PATH="$REPO_ROOT/$TARGET_DIR"
fi

if [[ -e "$TARGET_PATH" ]]; then
  echo "target already exists: $TARGET_DIR" >&2
  exit 1
fi

mkdir -p "$TARGET_PATH"
cp "$REPO_ROOT/examples/bot/persona.md" "$TARGET_PATH/persona.md"
cp "$REPO_ROOT/examples/bot/bot.json" "$TARGET_PATH/bot.json"
cp "$REPO_ROOT/examples/bot/heartbeat.md" "$TARGET_PATH/heartbeat.md"
mkdir -p "$TARGET_PATH/auth" "$TARGET_PATH/media" "$TARGET_PATH/logs"

node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";

  const botId = process.argv[1];
  const filePath = process.argv[2];
  const config = JSON.parse(readFileSync(filePath, "utf8"));
  config.botId = botId;
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
' "$BOT_ID" "$TARGET_PATH/bot.json"

echo "initialized bot scaffold at $TARGET_DIR"
