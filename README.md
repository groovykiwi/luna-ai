# Luna

Luna is a minimal WhatsApp bot framework focused on two things only: personality and memory.

## VPS Install

```bash
curl -fsSL https://raw.githubusercontent.com/groovykiwi/luna/main/scripts/install.sh | bash
```

The installer will:

- clone the repo
- ask for the install directory
- ask for the bot ID
- ask for `OPENROUTER_API_KEY`
- create `.env`
- initialize `bots/<bot-id>/`
- optionally start Docker

If the repo is private, use the manual setup below instead.

## Manual Setup

```bash
git clone git@github.com:groovykiwi/luna.git
cd luna
cp .env.example .env
./scripts/init-bot.sh maya
```

Then edit:

- `bots/maya/persona.md`
- `bots/maya/bot.json`
- `.env`

Start the bot:

```bash
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

## Notes

- All runtime state lives in `bots/<bot-id>/`.
- For a fresh server, do not copy `bot.db`, `media/`, or `logs/`.
- Copy `auth/` only if you want to keep the existing WhatsApp login.
