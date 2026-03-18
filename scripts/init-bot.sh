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
ESCAPED_BOT_ID="$(printf '%s' "$BOT_ID" | sed 's/[\\/&]/\\&/g')"

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

TMP_CONFIG_PATH="$TARGET_PATH/bot.json.tmp"
sed "s/\"example-bot\"/\"$ESCAPED_BOT_ID\"/g" "$TARGET_PATH/bot.json" > "$TMP_CONFIG_PATH"
mv "$TMP_CONFIG_PATH" "$TARGET_PATH/bot.json"

echo "initialized bot scaffold at $TARGET_DIR"
