#!/usr/bin/env bash

set -euo pipefail

TTY="/dev/tty"
REPO_URL="${LUNA_REPO_URL:-https://github.com/groovykiwi/luna-ai.git}"
REPO_REF="${LUNA_REF:-main}"

if [[ ! -r "$TTY" ]]; then
  echo "This installer requires an interactive terminal." >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

prompt_with_default() {
  local prompt="$1"
  local default_value="$2"
  local response

  read -r -p "$prompt [$default_value]: " response < "$TTY"
  if [[ -z "$response" ]]; then
    printf '%s\n' "$default_value"
    return
  fi

  printf '%s\n' "$response"
}

prompt_required_secret() {
  local prompt="$1"
  local response=""

  while [[ -z "$response" ]]; do
    read -r -s -p "$prompt: " response < "$TTY"
    printf '\n' > "$TTY"
  done

  printf '%s\n' "$response"
}

confirm_yes_no() {
  local prompt="$1"
  local default_answer="${2:-y}"
  local suffix="[Y/n]"
  local response

  if [[ "$default_answer" = "n" ]]; then
    suffix="[y/N]"
  fi

  read -r -p "$prompt $suffix: " response < "$TTY"
  response="$(printf '%s' "$response" | tr '[:upper:]' '[:lower:]')"

  if [[ -z "$response" ]]; then
    response="$default_answer"
  fi

  [[ "$response" = "y" || "$response" = "yes" ]]
}

require_command git

printf 'Luna AI installer\n'

INSTALL_DIR="$(prompt_with_default "Install directory" "./luna-ai")"
BOT_ID="$(prompt_with_default "Bot ID" "maya")"
OPENROUTER_API_KEY="$(prompt_required_secret "OpenRouter API key")"

if [[ -e "$INSTALL_DIR" ]]; then
  echo "Install directory already exists: $INSTALL_DIR" >&2
  exit 1
fi

git clone --branch "$REPO_REF" --single-branch "$REPO_URL" "$INSTALL_DIR"

cd "$INSTALL_DIR"

./scripts/init-bot.sh "$BOT_ID"

cat > .env <<EOF
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
BOT_PATH=./bots/$BOT_ID
BOT_HOST_PATH=./bots/$BOT_ID
EOF

chmod 600 .env || true

printf '\nSetup complete.\n'
printf 'Bot folder: %s\n' "bots/$BOT_ID"
printf 'Edit persona: %s\n' "bots/$BOT_ID/persona.md"
printf 'Edit config: %s\n' "bots/$BOT_ID/bot.json"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if confirm_yes_no "Start Luna with docker compose now?" "y"; then
    docker compose up -d --build
    printf '\nLuna AI is starting.\n'
    printf 'Watch logs with: docker compose logs -f\n'
    exit 0
  fi
else
  printf '\nDocker Compose was not detected. Start it later with: docker compose up -d --build\n'
fi

printf '\nNext step: cd %s && docker compose up -d --build\n' "$INSTALL_DIR"
