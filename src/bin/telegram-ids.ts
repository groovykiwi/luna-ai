import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

import type { RuntimeContext } from "../domain.js";
import { loadRuntimeContext } from "../runtime.js";

interface TelegramIdRow {
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  lastSeenAt: string;
}

function printHelp(stdout: Pick<NodeJS.WriteStream, "write">): void {
  stdout.write("Usage: pnpm telegram-ids -- [--help]\n");
  stdout.write("Shows Telegram DM chat IDs and user IDs from the current bot database.\n");
}

function parseArgs(argv: string[]): { help: boolean } {
  let help = false;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help };
}

export function listTelegramIds(dbPath: string): TelegramIdRow[] {
  if (!existsSync(dbPath)) {
    return [];
  }

  const database = new Database(dbPath, { readonly: true });

  try {
    return database
      .prepare(
        `SELECT chats.jid AS chatJid,
                messages.sender_jid AS senderJid,
                MAX(NULLIF(messages.sender_name, '')) AS senderName,
                MAX(messages.created_at) AS lastSeenAt
         FROM messages
         JOIN chats ON chats.id = messages.chat_id
         WHERE chats.jid LIKE 'tg:chat:%'
           AND messages.sender_jid LIKE 'tg:user:%'
           AND messages.is_from_bot = 0
         GROUP BY chats.jid, messages.sender_jid
         ORDER BY lastSeenAt DESC, chats.jid ASC`
      )
      .all() as TelegramIdRow[];
  } finally {
    database.close();
  }
}

function formatSenderLabel(row: TelegramIdRow): string {
  return row.senderName?.trim() || row.senderJid;
}

export function runTelegramIdsCli(options: {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  loadRuntimeContext?: () => RuntimeContext;
  listTelegramIds?: (dbPath: string) => TelegramIdRow[];
} = {}): void {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const parsed = parseArgs(argv);

  if (parsed.help) {
    printHelp(stdout);
    return;
  }

  const runtimeContext = (options.loadRuntimeContext ?? loadRuntimeContext)();
  const rows = (options.listTelegramIds ?? listTelegramIds)(runtimeContext.paths.dbPath);

  stdout.write(`Telegram IDs for bot "${runtimeContext.botConfig.botId}"\n`);
  stdout.write(`Bot path: ${runtimeContext.paths.botPath}\n`);
  stdout.write(`Database: ${runtimeContext.paths.dbPath}\n`);
  stdout.write("Use telegram.replyWhitelist.dms with tg:chat:... and telegram.admins with tg:user:...\n");

  if (rows.length === 0) {
    stdout.write("\nNo Telegram DMs found yet.\n");
    stdout.write("Send the bot a Telegram DM first, then rerun this command.\n");
    return;
  }

  rows.forEach((row, index) => {
    stdout.write(`\n${index + 1}. ${formatSenderLabel(row)}\n`);
    stdout.write(`   telegram.replyWhitelist.dms: ${row.chatJid}\n`);
    stdout.write(`   telegram.admins: ${row.senderJid}\n`);
    stdout.write(`   lastSeenAt: ${row.lastSeenAt}\n`);
  });
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryHref === import.meta.url) {
  runTelegramIdsCli();
}
