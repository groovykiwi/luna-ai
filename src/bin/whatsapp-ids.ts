import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

import type { RuntimeContext } from "../domain.js";
import { loadRuntimeContext } from "../runtime.js";

interface WhatsAppDmRow {
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  lastSeenAt: string;
}

interface WhatsAppGroupRow {
  chatJid: string;
  lastSeenAt: string;
}

interface WhatsAppUserRow {
  senderJid: string;
  senderName: string | null;
  lastSeenAt: string;
}

interface WhatsAppIdsResult {
  dms: WhatsAppDmRow[];
  groups: WhatsAppGroupRow[];
  users: WhatsAppUserRow[];
}

function printHelp(stdout: Pick<NodeJS.WriteStream, "write">): void {
  stdout.write("Usage: pnpm whatsapp-ids -- [--help]\n");
  stdout.write("Shows WhatsApp DM, group, and user IDs from the current bot database.\n");
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

export function listWhatsAppIds(dbPath: string): WhatsAppIdsResult {
  const database = new Database(dbPath, { readonly: true });

  try {
    const dms = database
      .prepare(
        `SELECT chats.jid AS chatJid,
                messages.sender_jid AS senderJid,
                MAX(NULLIF(messages.sender_name, '')) AS senderName,
                MAX(messages.created_at) AS lastSeenAt
         FROM messages
         JOIN chats ON chats.id = messages.chat_id
         WHERE chats.type = 'dm'
           AND chats.jid NOT LIKE 'tg:%'
           AND messages.sender_jid NOT LIKE 'tg:%'
           AND messages.is_from_bot = 0
         GROUP BY chats.jid, messages.sender_jid
         ORDER BY lastSeenAt DESC, chats.jid ASC`
      )
      .all() as WhatsAppDmRow[];

    const groups = database
      .prepare(
        `SELECT jid AS chatJid,
                last_active_at AS lastSeenAt
         FROM chats
         WHERE type = 'group'
           AND jid NOT LIKE 'tg:%'
         ORDER BY lastSeenAt DESC, chatJid ASC`
      )
      .all() as WhatsAppGroupRow[];

    const users = database
      .prepare(
        `SELECT messages.sender_jid AS senderJid,
                MAX(NULLIF(messages.sender_name, '')) AS senderName,
                MAX(messages.created_at) AS lastSeenAt
         FROM messages
         JOIN chats ON chats.id = messages.chat_id
         WHERE chats.jid NOT LIKE 'tg:%'
           AND messages.sender_jid NOT LIKE 'tg:%'
           AND messages.is_from_bot = 0
         GROUP BY messages.sender_jid
         ORDER BY lastSeenAt DESC, senderJid ASC`
      )
      .all() as WhatsAppUserRow[];

    return { dms, groups, users };
  } finally {
    database.close();
  }
}

function formatLabel(name: string | null, fallback: string): string {
  return name?.trim() || fallback;
}

export function runWhatsAppIdsCli(options: {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  loadRuntimeContext?: () => RuntimeContext;
  listWhatsAppIds?: (dbPath: string) => WhatsAppIdsResult;
} = {}): void {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const parsed = parseArgs(argv);

  if (parsed.help) {
    printHelp(stdout);
    return;
  }

  const runtimeContext = (options.loadRuntimeContext ?? loadRuntimeContext)();
  const result = (options.listWhatsAppIds ?? listWhatsAppIds)(runtimeContext.paths.dbPath);

  stdout.write(`WhatsApp IDs for bot "${runtimeContext.botConfig.botId}"\n`);
  stdout.write(`Bot path: ${runtimeContext.paths.botPath}\n`);
  stdout.write(`Database: ${runtimeContext.paths.dbPath}\n`);
  stdout.write("Use whatsapp.replyWhitelist.dms/groups with chat JIDs and whatsapp.admins with sender JIDs.\n");

  if (result.dms.length === 0 && result.groups.length === 0 && result.users.length === 0) {
    stdout.write("\nNo WhatsApp chats found yet.\n");
    stdout.write("Send the bot a WhatsApp DM or mention it in a group first, then rerun this command.\n");
    return;
  }

  if (result.dms.length > 0) {
    stdout.write("\nDM chats\n");
    result.dms.forEach((row, index) => {
      stdout.write(`\n${index + 1}. ${formatLabel(row.senderName, row.chatJid)}\n`);
      stdout.write(`   whatsapp.replyWhitelist.dms: ${row.chatJid}\n`);
      stdout.write(`   whatsapp.admins: ${row.senderJid}\n`);
      stdout.write(`   lastSeenAt: ${row.lastSeenAt}\n`);
    });
  }

  if (result.groups.length > 0) {
    stdout.write("\nGroup chats\n");
    result.groups.forEach((row, index) => {
      stdout.write(`\n${index + 1}. ${row.chatJid}\n`);
      stdout.write(`   whatsapp.replyWhitelist.groups: ${row.chatJid}\n`);
      stdout.write(`   lastSeenAt: ${row.lastSeenAt}\n`);
    });
  }

  if (result.users.length > 0) {
    stdout.write("\nRecent users\n");
    result.users.forEach((row, index) => {
      stdout.write(`\n${index + 1}. ${formatLabel(row.senderName, row.senderJid)}\n`);
      stdout.write(`   whatsapp.admins: ${row.senderJid}\n`);
      stdout.write(`   lastSeenAt: ${row.lastSeenAt}\n`);
    });
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryHref === import.meta.url) {
  runWhatsAppIdsCli();
}
