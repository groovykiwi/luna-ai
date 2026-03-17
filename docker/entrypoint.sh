#!/usr/bin/env bash
set -euo pipefail

node /app/dist/bin/worker.js &
worker_pid=$!

node /app/dist/bin/chat.js &
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
