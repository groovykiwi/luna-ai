#!/usr/bin/env bash
set -euo pipefail

resolve_entry() {
  local name="$1"
  local src_path="/app/dist/src/bin/$name.js"
  local legacy_path="/app/dist/bin/$name.js"

  if [[ -f "$src_path" ]]; then
    printf '%s\n' "$src_path"
    return
  fi

  if [[ -f "$legacy_path" ]]; then
    printf '%s\n' "$legacy_path"
    return
  fi

  echo "Unable to find compiled entrypoint for $name." >&2
  exit 1
}

worker_entry="$(resolve_entry worker)"
chat_entry="$(resolve_entry chat)"

node "$worker_entry" &
worker_pid=$!

node "$chat_entry" &
chat_pid=$!

shutdown() {
  kill "$worker_pid" "$chat_pid" 2>/dev/null || true
  wait "$worker_pid" "$chat_pid" 2>/dev/null || true
}

trap shutdown INT TERM

wait -n "$worker_pid" "$chat_pid"
status=$?
shutdown
exit "$status"
