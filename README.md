# Luna

Luna is a minimal, production-grade WhatsApp bot framework built around two things only: personality and memory.

This repo is meant to be pushed as a clean code template. Actual bot state stays local to each deployment:

- bot config and persona
- SQLite database
- Baileys auth/session state
- downloaded media
- logs

That state lives under `bots/<bot-id>/` on the machine running the bot and is intentionally gitignored.

## Recommended Deployment Model

Use a normal GitHub repository or GitHub template repo.

That is still the right source-of-truth model. The installer below is only a convenience layer on top:

- the code is visible before you run it
- updates are just `git pull`
- the deployment is reproducible
- your VPS setup can stay very small: clone, create one bot folder, fill `.env`, start Docker

## One-Line Installer

Once this repo is pushed to GitHub, you can install it on a VPS with:

```bash
curl -fsSL https://raw.githubusercontent.com/groovykiwi/luna/main/scripts/install.sh | bash
```

The installer will prompt for:

- install directory
- bot ID
- `OPENROUTER_API_KEY`
- whether to start Docker immediately

It then:

- clones the repo
- creates `.env`
- creates `bots/<bot-id>/`
- initializes `persona.md` and `bot.json`
- optionally runs `docker compose up -d --build`

## Fresh VPS Setup

1. Install Docker and Docker Compose on the VPS.
2. Clone this repo.
3. Copy `.env.example` to `.env`.
4. Create a fresh bot folder with the init script.
5. Edit the generated `persona.md` and `bot.json`.
6. Start the container.

Example:

```bash
git clone <your-repo-url> luna
cd luna
cp .env.example .env
./scripts/init-bot.sh maya
```

Then edit `.env`:

```env
OPENROUTER_API_KEY=your_real_key
BOT_PATH=./bots/maya
BOT_HOST_PATH=./bots/maya
```

Then start the bot:

```bash
docker compose up -d --build
```

To watch logs:

```bash
docker compose logs -f
```

## Local Development

For non-Docker runs, `BOT_PATH` points to the bot folder:

```bash
pnpm install
pnpm approve-builds --all
cp .env.example .env
./scripts/init-bot.sh maya
pnpm worker
pnpm chat
```

## Creating A Fresh Bot

The init script copies the committed example scaffold into `bots/<bot-id>/` and rewrites the `botId`.

Example:

```bash
./scripts/init-bot.sh maya
```

That creates:

```text
bots/
  maya/
    persona.md
    bot.json
    auth/
    media/
    logs/
```

`bot.db` is created automatically on first run.

## What Not To Copy To A New Server

If you want a fresh start on the VPS, do not copy any of these from your local machine:

- `bots/<bot-id>/bot.db`
- `bots/<bot-id>/auth/`
- `bots/<bot-id>/media/`
- `bots/<bot-id>/logs/`

Only copy or recreate:

- the codebase
- `.env`
- the new bot's `persona.md`
- the new bot's `bot.json`

## Example Bot Scaffold

A committed example bot scaffold lives in:

- `examples/bot/persona.md`
- `examples/bot/bot.json`

Use it as the source of truth for new bots, not `bots/`.
