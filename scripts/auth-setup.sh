#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TTY="/dev/tty"

build_image=0
provider_choice=""
forward_args=()

has_interactive_tty() {
  [[ -t 0 || -t 1 || -t 2 ]] && [[ -r "$TTY" ]]
}

local_cli_ready() {
  [[ -x "$REPO_ROOT/node_modules/.bin/tsx" ]]
}

ensure_local_cli_ready() {
  if local_cli_ready; then
    return
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "Local pnpm dependencies are not installed and pnpm is unavailable." >&2
    echo "Install pnpm locally or run auth setup with Docker Compose available." >&2
    exit 1
  fi

  printf 'Bootstrapping local pnpm dependencies for auth setup...\n'
  pnpm install --frozen-lockfile
  pnpm approve-builds --all

  if ! local_cli_ready; then
    echo "Local auth setup is still unavailable after pnpm install." >&2
    exit 1
  fi
}

confirm_yes_no() {
  local prompt="$1"
  local default_answer="${2:-y}"
  local suffix="[Y/n]"
  local response

  if [[ "$default_answer" = "n" ]]; then
    suffix="[y/N]"
  fi

  if ! has_interactive_tty; then
    [[ "$default_answer" = "y" ]]
    return
  fi

  read -r -p "$prompt $suffix: " response < "$TTY"
  response="$(printf '%s' "$response" | tr '[:upper:]' '[:lower:]')"

  if [[ -z "$response" ]]; then
    response="$default_answer"
  fi

  [[ "$response" = "y" || "$response" = "yes" ]]
}

resolve_bot_path_for_fs() {
  local bot_path="$1"
  if [[ "$bot_path" = /* ]]; then
    printf '%s\n' "$bot_path"
    return
  fi

  printf '%s\n' "$REPO_ROOT/$bot_path"
}

is_valid_bot_path() {
  local bot_path="$1"
  local resolved
  resolved="$(resolve_bot_path_for_fs "$bot_path")"
  [[ -d "$resolved" && -f "$resolved/bot.json" && -f "$resolved/persona.md" ]]
}

read_bot_id_from_path() {
  local bot_path="$1"
  local resolved
  resolved="$(resolve_bot_path_for_fs "$bot_path")"

  if [[ ! -f "$resolved/bot.json" ]]; then
    return 0
  fi

  sed -n 's/^[[:space:]]*"botId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$resolved/bot.json" | head -n 1
}

discover_default_bot_path() {
  local bots_dir="$REPO_ROOT/bots"
  local candidates=()
  local entry

  if [[ ! -d "$bots_dir" ]]; then
    return 0
  fi

  for entry in "$bots_dir"/*; do
    if [[ -d "$entry" && -f "$entry/bot.json" && -f "$entry/persona.md" ]]; then
      candidates+=("./bots/$(basename "$entry")")
    fi
  done

  if [[ ${#candidates[@]} -eq 1 ]]; then
    printf '%s\n' "${candidates[0]}"
  fi
}

read_dotenv_value() {
  local key="$1"
  local env_file="$REPO_ROOT/.env"

  if [[ ! -f "$env_file" ]]; then
    return 0
  fi

  awk -F= -v key="$key" '$1 == key { value = substr($0, index($0, "=") + 1) } END { if (value != "") print value }' "$env_file"
}

write_dotenv_value() {
  local key="$1"
  local value="$2"
  local env_file="$REPO_ROOT/.env"
  local tmp_file

  tmp_file="$(mktemp)"

  if [[ -f "$env_file" ]]; then
    awk -F= -v key="$key" -v value="$value" '
      BEGIN { replaced = 0 }
      $1 == key {
        if (!replaced) {
          print key "=" value
          replaced = 1
        }
        next
      }
      { print }
      END {
        if (!replaced) {
          print key "=" value
        }
      }
    ' "$env_file" > "$tmp_file"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp_file"
  fi

  mv "$tmp_file" "$env_file"
}

prompt_required_secret() {
  local prompt="$1"
  local response=""

  if ! has_interactive_tty; then
    echo "No TTY available. Set TELEGRAM_BOT_TOKEN in the environment or .env before running auth setup." >&2
    exit 1
  fi

  while [[ -z "$response" ]]; do
    read -r -s -p "$prompt: " response < "$TTY"
    printf '\n' > "$TTY"
  done

  printf '%s\n' "$response"
}

ensure_telegram_token() {
  local token="${TELEGRAM_BOT_TOKEN:-}"
  if [[ -n "$token" ]]; then
    return
  fi

  token="$(read_dotenv_value TELEGRAM_BOT_TOKEN)"
  if [[ -n "$token" ]]; then
    export TELEGRAM_BOT_TOKEN="$token"
    return
  fi

  token="$(prompt_required_secret "Telegram bot token (BotFather)")"
  export TELEGRAM_BOT_TOKEN="$token"
  write_dotenv_value TELEGRAM_BOT_TOKEN "$token"
  chmod 600 "$REPO_ROOT/.env" 2>/dev/null || true
  printf 'Saved TELEGRAM_BOT_TOKEN to .env\n'
}

choose_bot_path() {
  local current_bot_path="${BOT_PATH:-}"
  local current_bot_id=""
  local selected_bot_path=""
  local entered_path=""

  if [[ -z "$current_bot_path" ]]; then
    current_bot_path="$(read_dotenv_value BOT_PATH)"
  fi

  if [[ -z "$current_bot_path" ]]; then
    current_bot_path="$(discover_default_bot_path)"
  fi

  if [[ -n "$current_bot_path" ]] && is_valid_bot_path "$current_bot_path"; then
    current_bot_id="$(read_bot_id_from_path "$current_bot_path")"
  fi

  printf 'Current bot path: %s\n' "${current_bot_path:-<not set>}"
  printf 'Current bot ID: %s\n' "${current_bot_id:-<unknown>}"

  if [[ -n "$current_bot_path" ]] && is_valid_bot_path "$current_bot_path"; then
    if confirm_yes_no "Use this bot for auth setup?" "y"; then
      selected_bot_path="$current_bot_path"
    fi
  elif [[ -n "$current_bot_path" ]]; then
    printf 'Current BOT_PATH is not a valid bot folder.\n'
  fi

  while [[ -z "$selected_bot_path" ]]; do
    if ! has_interactive_tty; then
      echo "No TTY available. Set BOT_PATH to a valid bot folder before running auth setup." >&2
      exit 1
    fi

    read -r -p "Bot path to use [./bots/maya]: " entered_path < "$TTY"
    entered_path="${entered_path:-./bots/maya}"

    if is_valid_bot_path "$entered_path"; then
      selected_bot_path="$entered_path"
    else
      printf 'Invalid bot path: %s\n' "$entered_path" > "$TTY"
      printf 'Expected a folder containing bot.json and persona.md.\n' > "$TTY"
    fi
  done

  export BOT_PATH="$selected_bot_path"
  export BOT_HOST_PATH="$selected_bot_path"
  write_dotenv_value BOT_PATH "$selected_bot_path"
  write_dotenv_value BOT_HOST_PATH "$selected_bot_path"
  chmod 600 "$REPO_ROOT/.env" 2>/dev/null || true

  printf 'Using bot path: %s\n' "$selected_bot_path"
  printf 'Bot to modify: %s\n' "$(read_bot_id_from_path "$selected_bot_path")"
}

print_help() {
  cat <<'EOF'
Usage: ./scripts/auth-setup.sh [--whatsapp|--telegram|--both] [--build-image] [--demo-whatsapp] [--reset|--reinit] [--help]

  --whatsapp    Run WhatsApp auth setup.
  --telegram    Run Telegram auth setup.
  --both        Run both WhatsApp and Telegram auth setup in sequence.
  --build-image Build the Docker image before the first auth run.
  --demo-whatsapp  WhatsApp-only QR dry run.
  --reset       Reset provider auth state before setup.
  --reinit      Alias for --reset.
  --help        Show this help text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-image)
      build_image=1
      shift
      ;;
    --whatsapp)
      provider_choice="whatsapp"
      shift
      ;;
    --telegram)
      provider_choice="telegram"
      shift
      ;;
    --both)
      provider_choice="both"
      shift
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      forward_args+=("$1")
      shift
      ;;
  esac
done

choose_provider_interactively() {
  local response=""
  if ! has_interactive_tty; then
    echo "No TTY available. Pass --whatsapp, --telegram, or --both." >&2
    exit 1
  fi

  while true; do
    read -r -p "Auth setup target [whatsapp/telegram/both] [whatsapp]: " response < "$TTY"
    response="${response:-whatsapp}"
    case "$response" in
      whatsapp|telegram|both)
        provider_choice="$response"
        return
        ;;
    esac
  done
}

run_local_auth() {
  local provider="$1"
  ensure_local_cli_ready
  if [[ "$provider" == "telegram" ]]; then
    ensure_telegram_token
  fi

  local cmd=(pnpm auth -- --provider "$provider")
  if [[ ${#forward_args[@]} -gt 0 ]]; then
    cmd+=("${forward_args[@]}")
  fi

  "${cmd[@]}"
}

docker_compose_ready() {
  command -v docker >/dev/null 2>&1 &&
    docker compose version >/dev/null 2>&1 &&
    docker compose config >/dev/null 2>&1 &&
    docker info >/dev/null 2>&1
}

run_docker_auth() {
  local provider="$1"
  local build_flag=()
  local cmd=(docker compose run --rm)
  if [[ "$provider" == "telegram" ]]; then
    ensure_telegram_token
  fi

  if [[ "$build_image" -eq 1 ]]; then
    build_flag=(--build)
    build_image=0
  fi

  if [[ ${#build_flag[@]} -gt 0 ]]; then
    cmd+=("${build_flag[@]}")
  fi

  if [[ "$provider" == "telegram" ]]; then
    cmd+=(-e "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}")
  fi

  cmd+=(--no-deps luna auth --provider "$provider")
  if [[ ${#forward_args[@]} -gt 0 ]]; then
    cmd+=("${forward_args[@]}")
  fi

  "${cmd[@]}"
}

run_auth_sequence() {
  local runner="$1"

  case "$provider_choice" in
    whatsapp)
      "$runner" whatsapp
      ;;
    telegram)
      "$runner" telegram
      ;;
    both)
      "$runner" whatsapp
      "$runner" telegram
      ;;
    *)
      echo "Unknown auth setup target: $provider_choice" >&2
      exit 1
      ;;
  esac
}

cd "$REPO_ROOT"

choose_bot_path

if [[ -z "$provider_choice" ]]; then
  choose_provider_interactively
fi

if docker_compose_ready; then
  was_running=0
  if docker compose ps --status running --services 2>/dev/null | grep -qx "luna"; then
    was_running=1
    printf 'Stopping the running Luna service before auth setup...\n'
    docker compose stop luna
  fi

  restore_service() {
    if [[ "$was_running" -eq 1 ]]; then
      printf 'Restarting the Luna service...\n'
      docker compose up -d luna >/dev/null
    fi
  }

  trap restore_service EXIT
  run_auth_sequence run_docker_auth
  exit 0
fi

if command -v pnpm >/dev/null 2>&1; then
  run_auth_sequence run_local_auth
  exit 0
fi

echo "Unable to run auth setup." >&2
echo "Docker Compose must have a valid .env/BOT_HOST_PATH and a running Docker engine, or pnpm must be available locally." >&2
exit 1
