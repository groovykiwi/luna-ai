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

has_docker_compose() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

docker_engine_ready() {
  has_docker_compose && docker info >/dev/null 2>&1
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  require_command sudo
  sudo "$@"
}

wait_for_docker_engine() {
  local timeout_seconds="${1:-60}"
  local elapsed=0

  while (( elapsed < timeout_seconds )); do
    if docker_engine_ready; then
      return 0
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  return 1
}

install_docker_linux() {
  require_command curl
  printf '\nInstalling Docker Engine and Compose plugin using Docker''s official convenience script...\n'

  if [[ "$(id -u)" -eq 0 ]]; then
    curl -fsSL https://get.docker.com | sh
  else
    curl -fsSL https://get.docker.com | sudo sh
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_as_root systemctl enable --now docker || true
  fi

  if [[ "$(id -u)" -ne 0 && -n "${USER:-}" ]] && command -v usermod >/dev/null 2>&1; then
    run_as_root usermod -aG docker "$USER" || true
    printf 'Added %s to the docker group. You may need to sign out and back in before docker works without sudo.\n' "$USER"
  fi
}

install_docker_macos() {
  if ! command -v brew >/dev/null 2>&1; then
    printf '\nDocker Desktop install on macOS requires Homebrew for this installer path.\n' >&2
    printf 'Install Homebrew from https://brew.sh and re-run the installer, or install Docker Desktop manually.\n' >&2
    return 1
  fi

  printf '\nInstalling Docker Desktop with Homebrew...\n'
  brew install --cask docker

  if command -v open >/dev/null 2>&1; then
    open -a Docker || true
    printf 'Docker Desktop has been launched. Complete any first-run prompts if they appear.\n'
  fi
}

attempt_docker_install() {
  case "$(uname -s)" in
    Darwin)
      install_docker_macos
      ;;
    Linux)
      install_docker_linux
      ;;
    *)
      printf '\nAutomatic Docker installation is not supported on this platform by the Luna installer.\n' >&2
      return 1
      ;;
  esac
}

ensure_docker_available() {
  if has_docker_compose; then
    return 0
  fi

  printf '\nDocker Compose was not detected on this system.\n'
  if ! confirm_yes_no "Attempt to install Docker now?" "y"; then
    return 1
  fi

  attempt_docker_install
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
BOT_ID="$(prompt_with_default "Bot ID" "luna")"
OPENROUTER_API_KEY="$(prompt_required_secret "OpenRouter API key")"

if [[ -e "$INSTALL_DIR" ]]; then
  echo "Install directory already exists: $INSTALL_DIR" >&2
  exit 1
fi

git clone --branch "$REPO_REF" --single-branch "$REPO_URL" "$INSTALL_DIR"

cd "$INSTALL_DIR"

./scripts/init-bot.sh "$BOT_ID"
chmod +x ./scripts/auth-setup.sh || true

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

if ensure_docker_available; then
  compose_needs_build=1

  if ! has_docker_compose; then
    printf '\nDocker installation finished, but the docker CLI or Compose plugin is still unavailable in this shell.\n'
    printf 'Open a new shell after the install completes, then run: docker compose up -d --build\n'
    exit 0
  fi

  if ! docker_engine_ready; then
    printf '\nDocker is installed, but the engine is not ready yet.\n'
    if wait_for_docker_engine 90; then
      :
    else
      printf 'Start Docker Desktop or finish any first-run setup, then run: docker compose up -d --build\n'
      exit 0
    fi
  fi

  if confirm_yes_no "Run auth setup now?" "y"; then
    if ./scripts/auth-setup.sh --build-image; then
      compose_needs_build=0
      printf '\nAuth setup finished.\n'
    else
      printf '\nAuth setup did not complete.\n'
      printf 'Retry later with: ./scripts/auth-setup.sh\n'
    fi
  else
    printf '\nYou can run auth setup later with: ./scripts/auth-setup.sh\n'
    printf 'For a WhatsApp QR dry run: ./scripts/auth-setup.sh --whatsapp --demo-whatsapp\n'
  fi

  if confirm_yes_no "Start Luna with docker compose now?" "y"; then
    if [[ "$compose_needs_build" -eq 1 ]]; then
      docker compose up -d --build
    else
      docker compose up -d
    fi
    printf '\nLuna AI is starting.\n'
    printf 'Watch logs with: docker compose logs -f\n'
    exit 0
  fi
else
  printf '\nDocker was not installed. Install it later, then run: docker compose up -d --build\n'
fi

printf '\nNext step: cd %s && docker compose up -d --build\n' "$INSTALL_DIR"
printf 'Auth setup later: cd %s && ./scripts/auth-setup.sh\n' "$INSTALL_DIR"
