#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if command -v pnpm >/dev/null 2>&1; then
  exec pnpm whatsapp-ids -- "$@"
fi

if command -v docker >/dev/null 2>&1 &&
  docker compose version >/dev/null 2>&1 &&
  docker compose config >/dev/null 2>&1 &&
  docker info >/dev/null 2>&1; then
  exec docker compose run --rm --no-deps luna whatsapp-ids "$@"
fi

echo "Unable to list WhatsApp IDs." >&2
echo "Install pnpm locally or run with Docker Compose available." >&2
exit 1
