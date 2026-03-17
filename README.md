<p align="center">
  <img src="assets/readme/hero.jpg" alt="Luna AI hero" width="100%">
</p>

# Luna AI
Personality-first WhatsApp bots with durable memory.

<p>
  <img alt="Node 22" src="https://img.shields.io/badge/Node-22-111827?style=flat-square&logo=node.js&logoColor=8cc84b">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-111827?style=flat-square&logo=typescript&logoColor=3178c6">
  <img alt="Baileys" src="https://img.shields.io/badge/WhatsApp-Baileys-111827?style=flat-square">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-Local-111827?style=flat-square&logo=sqlite&logoColor=4db6ac">
  <img alt="OpenRouter" src="https://img.shields.io/badge/LLM-OpenRouter-111827?style=flat-square">
</p>

Luna AI is a minimal production-grade framework for running WhatsApp bots that feel consistent, remember people over time, and are cheap to host. The scope is intentionally narrow: persona, memory, retrieval, and reliable chat delivery.

## What You Get

- Per-bot folders with `persona.md`, `bot.json`, SQLite state, auth, media, and logs
- Baileys-based WhatsApp transport with QR login and persistent sessions
- Shared long-term memory with embeddings and FTS fallback
- DM and group reply whitelists
- Docker deployment with one chat process and one background worker

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/groovykiwi/luna-ai/main/scripts/install.sh | bash
```

The installer clones the repo, prompts for the bot ID and `OPENROUTER_API_KEY`, writes `.env`, initializes `bots/<bot-id>/`, and can start Docker immediately.

Alternatively:
```bash
git clone git@github.com:groovykiwi/luna-ai.git
cd luna-ai
cp .env.example .env
./scripts/init-bot.sh maya
docker compose up -d --build
docker compose logs -f
```

## Local Dev

```bash
pnpm install
pnpm approve-builds --all
cp .env.example .env
./scripts/init-bot.sh maya
pnpm worker
pnpm chat
```

## State

- Runtime state lives in `bots/<bot-id>/`
- For a fresh VPS, do not copy `bot.db`, `media/`, or `logs/`
- Copy `auth/` only if you want to keep the existing WhatsApp login
