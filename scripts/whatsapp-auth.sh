#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

build_image=0
if [[ "${1:-}" == "--build-image" ]]; then
  build_image=1
  shift
fi

cd "$REPO_ROOT"

docker_compose_ready() {
  command -v docker >/dev/null 2>&1 &&
    docker compose version >/dev/null 2>&1 &&
    docker compose config >/dev/null 2>&1 &&
    docker info >/dev/null 2>&1
}

if docker_compose_ready; then
  was_running=0
  if docker compose ps --status running --services 2>/dev/null | grep -qx "luna"; then
    was_running=1
    printf 'Stopping the running Luna service before WhatsApp authentication...\n'
    docker compose stop luna
  fi

  restore_service() {
    if [[ "$was_running" -eq 1 ]]; then
      printf 'Restarting the Luna service...\n'
      docker compose up -d luna >/dev/null
    fi
  }

  trap restore_service EXIT
  if [[ "$build_image" -eq 1 ]]; then
    docker compose run --rm --build --no-deps luna auth "$@"
  else
    docker compose run --rm --no-deps luna auth "$@"
  fi
  exit 0
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm auth -- "$@"
  exit 0
fi

echo "Unable to run WhatsApp authentication." >&2
echo "Docker Compose must have a valid .env/BOT_HOST_PATH and a running Docker engine, or pnpm must be available locally." >&2
exit 1
