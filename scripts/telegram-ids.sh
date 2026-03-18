#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

local_cli_ready() {
  [[ -x "$REPO_ROOT/node_modules/.bin/tsx" ]]
}

docker_compose_ready() {
  command -v docker >/dev/null 2>&1 &&
    docker compose version >/dev/null 2>&1 &&
    docker compose config >/dev/null 2>&1 &&
    docker info >/dev/null 2>&1
}

ensure_local_cli_ready() {
  if local_cli_ready; then
    return
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "Unable to list Telegram IDs." >&2
    echo "Install pnpm locally or run with Docker Compose available." >&2
    exit 1
  fi

  printf 'Bootstrapping local pnpm dependencies for Telegram ID lookup...\n'
  pnpm install --frozen-lockfile
  pnpm approve-builds --all

  if ! local_cli_ready; then
    echo "Local Telegram ID lookup is still unavailable after pnpm install." >&2
    exit 1
  fi
}

cd "$REPO_ROOT"

if local_cli_ready; then
  exec pnpm telegram-ids -- "$@"
fi

if docker_compose_ready; then
  exec docker compose run --rm --no-deps luna telegram-ids "$@"
fi

ensure_local_cli_ready
exec pnpm telegram-ids -- "$@"
