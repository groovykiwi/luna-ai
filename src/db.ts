import Database from "better-sqlite3";

import type {
  ArchiveHit,
  BlockStatus,
  ChatType,
  ExtractionCandidate,
  JobStatus,
  JobType,
  MemoryCategory,
  MemoryItem,
  MemoryStatus,
  RetrievedMemory,
  StoredMessage
} from "./domain.js";
import { tryParseJson } from "./utils.js";

export interface IngestFlags {
  contextOnly: boolean;
  memoryEligible: boolean;
  wasTriggered: boolean;
  turnEligible: boolean;
}

export interface IngestPayload {
  chatJid: string;
  chatType: ChatType;
  senderJid: string;
  senderName: string | null;
  externalId: string;
  contentType: "text" | "image" | "system";
  text: string | null;
  imageDescription: string | null;
  quotedExternalId: string | null;
  mentions: string[];
  rawJson: string;
  createdAt: string;
  isFromBot: boolean;
  mediaFilePath?: string | null;
  mediaMimeType?: string | null;
  mediaErrorMessage?: string | null;
}

export interface IngestResult {
  messageId: number;
  chatId: number;
  blockId: number | null;
  blockClosed: boolean;
  closedBlockId: number | null;
}

export interface JobRow {
  id: number;
  type: JobType;
  status: JobStatus;
  payloadJson: string;
  attempts: number;
  errorMessage: string | null;
  leaseToken: string | null;
}

interface RawStoredMessageRow {
  id: number;
  chatId: number;
  blockId: number | null;
  externalId: string;
  senderJid: string;
  senderName: string | null;
  isFromBot: number;
  chatType: ChatType;
  contextOnly: number;
  memoryEligible: number;
  wasTriggered: number;
  turnEligible: number;
  contentType: "text" | "image" | "system";
  text: string | null;
  imageDescription: string | null;
  quotedExternalId: string | null;
  mentionsJson: string;
  createdAt: string;
  processedTurnAt: string | null;
}

const SCHEMA_VERSION = "3";
const COMPACTED_RAW_JSON = "{\"compacted\":true}";

export class LunaDbOpenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LunaDbOpenError";
  }
}

export class LunaDb {
  readonly connection: Database.Database;

  constructor(dbPath: string, busyTimeoutMs: number) {
    let connection: Database.Database | null = null;

    try {
      connection = new Database(dbPath);
      connection.pragma("journal_mode = WAL");
      connection.pragma(`busy_timeout = ${busyTimeoutMs}`);
      connection.pragma("foreign_keys = ON");
      this.connection = connection;
      this.verifyIntegrity();
      this.migrate();
    } catch (error) {
      try {
        connection?.close();
      } catch {
        // Best-effort cleanup only.
      }
      throw toLunaDbOpenError(dbPath, error);
    }
  }

  close(): void {
    this.connection.close();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('dm', 'group')),
        title TEXT,
        last_active_at TEXT NOT NULL,
        last_reviewed_message_id INTEGER,
        last_completed_bot_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(last_reviewed_message_id) REFERENCES messages(id),
        FOREIGN KEY(last_completed_bot_message_id) REFERENCES messages(id)
      );

      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'queued', 'running', 'done', 'failed')),
        message_count INTEGER NOT NULL DEFAULT 0,
        first_message_id INTEGER,
        last_message_id INTEGER,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        extraction_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        block_id INTEGER,
        external_id TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        sender_name TEXT,
        is_from_bot INTEGER NOT NULL,
        chat_type TEXT NOT NULL CHECK(chat_type IN ('dm', 'group')),
        context_only INTEGER NOT NULL,
        memory_eligible INTEGER NOT NULL,
        was_triggered INTEGER NOT NULL,
        turn_eligible INTEGER NOT NULL,
        content_type TEXT NOT NULL CHECK(content_type IN ('text', 'image', 'system')),
        text TEXT,
        image_description TEXT,
        media_id INTEGER,
        quoted_external_id TEXT,
        mentions_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_turn_at TEXT,
        turn_locked_at TEXT,
        UNIQUE(chat_id, external_id),
        FOREIGN KEY(chat_id) REFERENCES chats(id),
        FOREIGN KEY(block_id) REFERENCES blocks(id),
        FOREIGN KEY(media_id) REFERENCES media(id)
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('person', 'preference', 'relationship', 'running_joke', 'event', 'fact')),
        summary TEXT NOT NULL,
        details TEXT,
        source_block INTEGER,
        source_chat INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'superseded')),
        superseded_by INTEGER,
        embedding BLOB,
        FOREIGN KEY(source_block) REFERENCES blocks(id),
        FOREIGN KEY(source_chat) REFERENCES chats(id),
        FOREIGN KEY(superseded_by) REFERENCES memory_items(id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('extract_block', 'reindex', 'prune_media')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'failed')),
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        available_at TEXT NOT NULL,
        started_at TEXT,
        lease_token TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('downloaded', 'described', 'failed', 'pruned')),
        description TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pruned_at TEXT,
        FOREIGN KEY(message_id) REFERENCES messages(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_turn_queue ON messages(turn_eligible, processed_turn_at, is_from_bot, chat_id, id);
      CREATE INDEX IF NOT EXISTS idx_messages_turn_lock ON messages(turn_eligible, processed_turn_at, turn_locked_at, chat_id, id);
      CREATE INDEX IF NOT EXISTS idx_blocks_chat_status ON blocks(chat_id, status, id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at, id);
      CREATE INDEX IF NOT EXISTS idx_memory_items_status ON memory_items(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_media_status ON media(status, updated_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        search_text,
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, search_text)
        VALUES (new.id, trim(coalesce(new.text, '') || ' ' || coalesce(new.image_description, '')));
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, search_text)
        VALUES('delete', old.id, trim(coalesce(old.text, '') || ' ' || coalesce(old.image_description, '')));
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, search_text)
        VALUES('delete', old.id, trim(coalesce(old.text, '') || ' ' || coalesce(old.image_description, '')));
        INSERT INTO messages_fts(rowid, search_text)
        VALUES (new.id, trim(coalesce(new.text, '') || ' ' || coalesce(new.image_description, '')));
      END;
    `);

    if (!this.hasColumn("chats", "last_reviewed_message_id")) {
      this.connection.exec("ALTER TABLE chats ADD COLUMN last_reviewed_message_id INTEGER REFERENCES messages(id)");
    }

    if (!this.hasColumn("jobs", "lease_token")) {
      this.connection.exec("ALTER TABLE jobs ADD COLUMN lease_token TEXT");
    }

    const now = new Date().toISOString();
    this.connection
      .prepare(
        `INSERT INTO meta(key, value, updated_at)
         VALUES ('schema_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(SCHEMA_VERSION, now);
  }

  private verifyIntegrity(): void {
    const quickCheck = this.connection.prepare("PRAGMA quick_check").pluck().get() as string | undefined;
    if (quickCheck && quickCheck !== "ok") {
      throw new Error(`PRAGMA quick_check reported ${quickCheck}`);
    }
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    const columns = this.connection.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return columns.some((column) => column.name === columnName);
  }

  private getOrCreateChat(chatJid: string, chatType: ChatType, createdAt: string): { id: number } {
    const existing = this.connection
      .prepare("SELECT id FROM chats WHERE jid = ?")
      .get(chatJid) as { id: number } | undefined;

    if (existing) {
      this.connection
        .prepare("UPDATE chats SET type = ?, last_active_at = ?, updated_at = ? WHERE id = ?")
        .run(chatType, createdAt, createdAt, existing.id);
      return existing;
    }

    const inserted = this.connection
      .prepare(
        `INSERT INTO chats(jid, type, title, last_active_at, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?)`
      )
      .run(chatJid, chatType, createdAt, createdAt, createdAt);

    return { id: Number(inserted.lastInsertRowid) };
  }

  private getOpenBlock(chatId: number): { id: number; messageCount: number } | null {
    const row = this.connection
      .prepare("SELECT id, message_count AS messageCount FROM blocks WHERE chat_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
      .get(chatId) as { id: number; messageCount: number } | undefined;

    return row ?? null;
  }

  private createOpenBlock(chatId: number, createdAt: string): { id: number; messageCount: number } {
    const result = this.connection
      .prepare(
        `INSERT INTO blocks(chat_id, status, message_count, first_message_id, last_message_id, opened_at, closed_at, extraction_error, created_at, updated_at)
         VALUES (?, 'open', 0, NULL, NULL, ?, NULL, NULL, ?, ?)`
      )
      .run(chatId, createdAt, createdAt, createdAt);

    return {
      id: Number(result.lastInsertRowid),
      messageCount: 0
    };
  }

  ingestMessage(payload: IngestPayload, flags: IngestFlags, blockSize: number): IngestResult {
    const transaction = this.connection.transaction(() => {
      const chat = this.getOrCreateChat(payload.chatJid, payload.chatType, payload.createdAt);
      const existing = this.connection
        .prepare("SELECT id, block_id AS blockId FROM messages WHERE chat_id = ? AND external_id = ?")
        .get(chat.id, payload.externalId) as { id: number; blockId: number | null } | undefined;

      if (existing) {
        return {
          messageId: existing.id,
          chatId: chat.id,
          blockId: existing.blockId,
          blockClosed: false,
          closedBlockId: null
        };
      }

      const block = this.getOpenBlock(chat.id) ?? this.createOpenBlock(chat.id, payload.createdAt);

      const inserted = this.connection
        .prepare(
          `INSERT INTO messages(
             chat_id,
             block_id,
             external_id,
             sender_jid,
             sender_name,
             is_from_bot,
             chat_type,
             context_only,
             memory_eligible,
             was_triggered,
             turn_eligible,
             content_type,
             text,
             image_description,
             media_id,
             quoted_external_id,
             mentions_json,
             raw_json,
             created_at,
             processed_turn_at,
             turn_locked_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`
        )
        .run(
          chat.id,
          block.id,
          payload.externalId,
          payload.senderJid,
          payload.senderName,
          payload.isFromBot ? 1 : 0,
          payload.chatType,
          flags.contextOnly ? 1 : 0,
          flags.memoryEligible ? 1 : 0,
          flags.wasTriggered ? 1 : 0,
          flags.turnEligible ? 1 : 0,
          payload.contentType,
          payload.text,
          payload.imageDescription,
          payload.quotedExternalId,
          JSON.stringify(payload.mentions),
          payload.rawJson,
          payload.createdAt
        );

      const messageId = Number(inserted.lastInsertRowid);
      let mediaId: number | null = null;

      if (payload.mediaFilePath && payload.mediaMimeType) {
        const mediaInsert = this.connection
          .prepare(
            `INSERT INTO media(message_id, file_path, mime_type, status, description, error_message, created_at, updated_at, pruned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
          )
          .run(
            messageId,
            payload.mediaFilePath,
            payload.mediaMimeType,
            payload.mediaErrorMessage ? "failed" : (payload.imageDescription ? "described" : "downloaded"),
            payload.imageDescription,
            payload.mediaErrorMessage ?? null,
            payload.createdAt,
            payload.createdAt
          );

        mediaId = Number(mediaInsert.lastInsertRowid);
        this.connection.prepare("UPDATE messages SET media_id = ? WHERE id = ?").run(mediaId, messageId);
      }

      const newCount = block.messageCount + 1;
      this.connection
        .prepare(
          `UPDATE blocks
           SET message_count = ?,
               first_message_id = COALESCE(first_message_id, ?),
               last_message_id = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(newCount, messageId, messageId, payload.createdAt, block.id);

      let closedBlockId: number | null = null;
      if (newCount >= blockSize) {
        closedBlockId = block.id;
        this.connection
          .prepare(
            `UPDATE blocks
             SET status = 'queued',
                 closed_at = ?,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(payload.createdAt, payload.createdAt, block.id);
        this.enqueueJob("extract_block", { blockId: block.id }, payload.createdAt);
      }

      return {
        messageId,
        chatId: chat.id,
        blockId: block.id,
        blockClosed: closedBlockId !== null,
        closedBlockId
      };
    });

    return transaction();
  }

  enqueueJob(type: JobType, payload: Record<string, unknown>, now: string): number {
    const result = this.connection
      .prepare(
        `INSERT INTO jobs(type, status, payload_json, attempts, error_message, available_at, started_at, finished_at, created_at, updated_at)
         VALUES (?, 'queued', ?, 0, NULL, ?, NULL, NULL, ?, ?)`
      )
      .run(type, JSON.stringify(payload), now, now, now);

    return Number(result.lastInsertRowid);
  }

  reclaimRunningJobs(now: string, staleBefore: string): number {
    const result = this.connection
      .prepare(
        `UPDATE jobs
         SET status = 'queued',
             updated_at = ?,
             started_at = NULL,
             lease_token = NULL
         WHERE status = 'running'
           AND (started_at IS NULL OR started_at <= ?)`
      )
      .run(now, staleBefore);

    return result.changes;
  }

  claimNextJob(now: string, leaseToken: string): JobRow | null {
    const transaction = this.connection.transaction(() => {
      while (true) {
        const row = this.connection
          .prepare(
            `SELECT id, type, status, payload_json AS payloadJson, attempts, error_message AS errorMessage, lease_token AS leaseToken
             FROM jobs
             WHERE status = 'queued' AND available_at <= ?
             ORDER BY id ASC
             LIMIT 1`
          )
          .get(now) as JobRow | undefined;

        if (!row) {
          return null;
        }

        const claimed = this.connection
          .prepare(
            `UPDATE jobs
             SET status = 'running',
                 attempts = attempts + 1,
                 started_at = ?,
                 lease_token = ?,
                 updated_at = ?
             WHERE id = ?
               AND status = 'queued'
               AND available_at <= ?`
          )
          .run(now, leaseToken, now, row.id, now);

        if (claimed.changes === 1) {
          return {
            ...row,
            status: "running",
            attempts: row.attempts + 1,
            leaseToken
          } satisfies JobRow;
        }
      }
    });

    return transaction.immediate();
  }

  completeJob(jobId: number, leaseToken: string, now: string): boolean {
    const result = this.connection
      .prepare(
        `UPDATE jobs
         SET status = 'done',
             finished_at = ?,
             lease_token = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_token = ?`
      )
      .run(now, now, jobId, leaseToken);

    return result.changes === 1;
  }

  failJob(jobId: number, leaseToken: string, now: string, errorMessage: string): boolean {
    const result = this.connection
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error_message = ?,
             finished_at = ?,
             lease_token = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_token = ?`
      )
      .run(errorMessage, now, now, jobId, leaseToken);

    return result.changes === 1;
  }

  stillOwnsJobLease(jobId: number, leaseToken: string): boolean {
    const row = this.connection
      .prepare(
        `SELECT 1
         FROM jobs
         WHERE id = ?
           AND status = 'running'
           AND lease_token = ?
         LIMIT 1`
      )
      .get(jobId, leaseToken) as { 1: number } | undefined;

    return Boolean(row);
  }

  markBlockStatus(blockId: number, status: BlockStatus, now: string, errorMessage?: string | null): void {
    this.connection
      .prepare(
        `UPDATE blocks
         SET status = ?,
             extraction_error = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(status, errorMessage ?? null, now, blockId);
  }

  findQuotedMessage(chatId: number, externalId: string | null): Pick<StoredMessage, "id" | "isFromBot"> | null {
    if (!externalId) {
      return null;
    }

    const row = this.connection
      .prepare(
        `SELECT id, is_from_bot AS isFromBot
         FROM messages
         WHERE chat_id = ? AND external_id = ?
         LIMIT 1`
      )
      .get(chatId, externalId) as { id: number; isFromBot: number } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      isFromBot: row.isFromBot === 1
    };
  }

  findChatByJid(chatJid: string): { id: number; jid: string; type: ChatType } | null {
    const row = this.connection
      .prepare("SELECT id, jid, type FROM chats WHERE jid = ?")
      .get(chatJid) as { id: number; jid: string; type: ChatType } | undefined;

    return row ?? null;
  }

  listChatsWithPendingTurns(): number[] {
    const rows = this.connection
      .prepare(
        `SELECT chat_id AS chatId, MIN(id) AS firstPendingId
         FROM messages
         WHERE turn_eligible = 1 AND processed_turn_at IS NULL AND is_from_bot = 0
         GROUP BY chat_id
         ORDER BY firstPendingId ASC`
      )
      .all() as Array<{ chatId: number }>;

    return rows.map((row) => row.chatId);
  }

  listChatsWithHeartbeatBacklog(): number[] {
    const rows = this.connection
      .prepare(
        `SELECT m.chat_id AS chatId, MIN(m.id) AS firstUnreviewedId
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         WHERE m.is_from_bot = 0
           AND m.id > COALESCE(c.last_reviewed_message_id, 0)
           AND NOT EXISTS (
             SELECT 1
             FROM messages pending
             WHERE pending.chat_id = m.chat_id
               AND pending.is_from_bot = 0
               AND pending.turn_eligible = 1
               AND pending.processed_turn_at IS NULL
           )
         GROUP BY m.chat_id
         ORDER BY firstUnreviewedId ASC`
      )
      .all() as Array<{ chatId: number }>;

    return rows.map((row) => row.chatId);
  }

  private mapStoredMessageRow(row: RawStoredMessageRow): StoredMessage {
    return {
      id: row.id,
      chatId: row.chatId,
      blockId: row.blockId,
      externalId: row.externalId,
      senderJid: row.senderJid,
      senderName: row.senderName,
      isFromBot: row.isFromBot === 1,
      chatType: row.chatType,
      contextOnly: row.contextOnly === 1,
      memoryEligible: row.memoryEligible === 1,
      wasTriggered: row.wasTriggered === 1,
      turnEligible: row.turnEligible === 1,
      contentType: row.contentType,
      text: row.text,
      imageDescription: row.imageDescription,
      quotedExternalId: row.quotedExternalId,
      mentions: tryParseJson<string[]>(row.mentionsJson) ?? [],
      createdAt: row.createdAt,
      processedTurnAt: row.processedTurnAt
    };
  }

  getPendingTurnMessages(chatId: number): StoredMessage[] {
    const rows = this.connection
      .prepare(
        `SELECT
           id,
           chat_id AS chatId,
           block_id AS blockId,
           external_id AS externalId,
           sender_jid AS senderJid,
           sender_name AS senderName,
           is_from_bot AS isFromBot,
           chat_type AS chatType,
           context_only AS contextOnly,
           memory_eligible AS memoryEligible,
           was_triggered AS wasTriggered,
           turn_eligible AS turnEligible,
           content_type AS contentType,
           text,
           image_description AS imageDescription,
           quoted_external_id AS quotedExternalId,
           mentions_json AS mentionsJson,
           created_at AS createdAt,
           processed_turn_at AS processedTurnAt
         FROM messages
         WHERE chat_id = ? AND turn_eligible = 1 AND processed_turn_at IS NULL AND is_from_bot = 0
         ORDER BY id ASC`
      )
      .all(chatId) as RawStoredMessageRow[];

    return rows.map((row) => this.mapStoredMessageRow(row));
  }

  claimPendingTurnMessages(chatId: number, lockedAt: string): StoredMessage[] {
    const transaction = this.connection.transaction(() => {
      const rows = this.connection
        .prepare(
          `SELECT
             id,
             chat_id AS chatId,
             block_id AS blockId,
             external_id AS externalId,
             sender_jid AS senderJid,
             sender_name AS senderName,
             is_from_bot AS isFromBot,
             chat_type AS chatType,
             context_only AS contextOnly,
             memory_eligible AS memoryEligible,
             was_triggered AS wasTriggered,
             turn_eligible AS turnEligible,
             content_type AS contentType,
             text,
             image_description AS imageDescription,
             quoted_external_id AS quotedExternalId,
             mentions_json AS mentionsJson,
             created_at AS createdAt,
             processed_turn_at AS processedTurnAt
           FROM messages
           WHERE chat_id = ?
             AND turn_eligible = 1
             AND processed_turn_at IS NULL
             AND turn_locked_at IS NULL
             AND is_from_bot = 0
           ORDER BY id ASC`
        )
        .all(chatId) as RawStoredMessageRow[];

      if (rows.length === 0) {
        return [];
      }

      const messageIds = rows.map((row) => row.id);
      const placeholders = messageIds.map(() => "?").join(", ");
      this.connection
        .prepare(`UPDATE messages SET turn_locked_at = ? WHERE id IN (${placeholders})`)
        .run(lockedAt, ...messageIds);

      return rows.map((row) => this.mapStoredMessageRow(row));
    });

    return transaction.immediate();
  }

  getHeartbeatReviewMessages(chatId: number, limit: number): StoredMessage[] {
    const rows = this.connection
      .prepare(
        `SELECT
           id,
           chat_id AS chatId,
           block_id AS blockId,
           external_id AS externalId,
           sender_jid AS senderJid,
           sender_name AS senderName,
           is_from_bot AS isFromBot,
           chat_type AS chatType,
           context_only AS contextOnly,
           memory_eligible AS memoryEligible,
           was_triggered AS wasTriggered,
           turn_eligible AS turnEligible,
           content_type AS contentType,
           text,
           image_description AS imageDescription,
           quoted_external_id AS quotedExternalId,
           mentions_json AS mentionsJson,
           created_at AS createdAt,
           processed_turn_at AS processedTurnAt
         FROM messages
         WHERE chat_id = ?
           AND is_from_bot = 0
           AND id > COALESCE((SELECT last_reviewed_message_id FROM chats WHERE id = ?), 0)
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(chatId, chatId, limit) as RawStoredMessageRow[];

    return rows.map((row) => this.mapStoredMessageRow(row));
  }

  markTurnMessagesProcessed(messageIds: number[], now: string): void {
    if (messageIds.length === 0) {
      return;
    }

    const placeholders = messageIds.map(() => "?").join(", ");
    this.connection
      .prepare(`UPDATE messages SET processed_turn_at = ?, turn_locked_at = NULL WHERE id IN (${placeholders})`)
      .run(now, ...messageIds);
  }

  unlockTurnMessages(messageIds: number[]): void {
    if (messageIds.length === 0) {
      return;
    }

    const placeholders = messageIds.map(() => "?").join(", ");
    this.connection
      .prepare(`UPDATE messages SET turn_locked_at = NULL WHERE id IN (${placeholders})`)
      .run(...messageIds);
  }

  releaseStaleTurnLocks(staleBefore: string): number {
    const result = this.connection
      .prepare(
        `UPDATE messages
         SET turn_locked_at = NULL
         WHERE processed_turn_at IS NULL
           AND turn_locked_at IS NOT NULL
           AND turn_locked_at <= ?`
      )
      .run(staleBefore);

    return result.changes;
  }

  markChatReviewedThrough(chatId: number, messageId: number, now: string): void {
    this.connection
      .prepare(
        `UPDATE chats
         SET last_reviewed_message_id = CASE
               WHEN COALESCE(last_reviewed_message_id, 0) > ? THEN last_reviewed_message_id
               ELSE ?
             END,
             updated_at = ?
         WHERE id = ?`
      )
      .run(messageId, messageId, now, chatId);
  }

  getRecentWindow(chatId: number): StoredMessage[] {
    const blockRows = this.connection
      .prepare(
        `SELECT id
         FROM blocks
         WHERE chat_id = ?
           AND (
             status = 'open'
             OR status IN ('queued', 'running')
           )
         ORDER BY id DESC
         LIMIT 2`
      )
      .all(chatId) as Array<{ id: number }>;

    if (blockRows.length === 0) {
      return [];
    }

    const placeholders = blockRows.map(() => "?").join(", ");
    const rows = this.connection
      .prepare(
        `SELECT
           id,
           chat_id AS chatId,
           block_id AS blockId,
           external_id AS externalId,
           sender_jid AS senderJid,
           sender_name AS senderName,
           is_from_bot AS isFromBot,
           chat_type AS chatType,
           context_only AS contextOnly,
           memory_eligible AS memoryEligible,
           was_triggered AS wasTriggered,
           turn_eligible AS turnEligible,
           content_type AS contentType,
           text,
           image_description AS imageDescription,
           quoted_external_id AS quotedExternalId,
           mentions_json AS mentionsJson,
           created_at AS createdAt,
           processed_turn_at AS processedTurnAt
         FROM messages
         WHERE chat_id = ? AND block_id IN (${placeholders})
         ORDER BY id ASC`
      )
      .all(chatId, ...blockRows.map((row) => row.id)) as RawStoredMessageRow[];

    return rows.map((row) => this.mapStoredMessageRow(row));
  }

  getChatById(chatId: number): { id: number; jid: string; type: ChatType } | null {
    const row = this.connection
      .prepare("SELECT id, jid, type FROM chats WHERE id = ?")
      .get(chatId) as { id: number; jid: string; type: ChatType } | undefined;

    return row ?? null;
  }

  createBotMessage(
    chatJid: string,
    chatType: ChatType,
    senderJid: string,
    externalId: string,
    text: string,
    deliveredText: string,
    createdAt: string,
    blockSize: number
  ): { messageId: number; chatId: number } {
    const result = this.ingestMessage(
      {
        chatJid,
        chatType,
        senderJid,
        senderName: null,
        externalId,
        contentType: "text",
        text,
        imageDescription: null,
        quotedExternalId: null,
        mentions: [],
        rawJson: JSON.stringify({ source: "bot", deliveredText }),
        createdAt,
        isFromBot: true
      },
      {
        contextOnly: false,
        memoryEligible: true,
        wasTriggered: false,
        turnEligible: false
      },
      blockSize
    );

    this.connection
      .prepare("UPDATE chats SET last_completed_bot_message_id = ?, updated_at = ? WHERE id = ?")
      .run(result.messageId, createdAt, result.chatId);

    return {
      messageId: result.messageId,
      chatId: result.chatId
    };
  }

  getExtractionCandidates(blockId: number): ExtractionCandidate[] {
    const rows = this.connection
      .prepare(
        `SELECT id, sender_jid AS senderJid, is_from_bot AS isFromBot, content_type AS contentType, text, image_description AS imageDescription, created_at AS createdAt
         FROM messages
         WHERE block_id = ? AND memory_eligible = 1
         ORDER BY id ASC`
      )
      .all(blockId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
        id: Number(row.id),
        senderJid: String(row.senderJid),
        isFromBot: Number(row.isFromBot) === 1,
        contentType: String(row.contentType) as ExtractionCandidate["contentType"],
        text: (row.text as string | null) ?? null,
        imageDescription: (row.imageDescription as string | null) ?? null,
        createdAt: String(row.createdAt)
      }));
  }

  getBlockChatId(blockId: number): number | null {
    const row = this.connection
      .prepare("SELECT chat_id AS chatId FROM blocks WHERE id = ?")
      .get(blockId) as { chatId: number } | undefined;

    return row?.chatId ?? null;
  }

  insertMemory(
    category: MemoryCategory,
    summary: string,
    details: string | null,
    sourceBlock: number | null,
    sourceChat: number | null,
    embedding: Buffer | null,
    createdAt: string
  ): number {
    const result = this.connection
      .prepare(
        `INSERT INTO memory_items(
           category,
           summary,
           details,
           source_block,
           source_chat,
           created_at,
           updated_at,
           status,
           superseded_by,
           embedding
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`
      )
      .run(category, summary, details, sourceBlock, sourceChat, createdAt, createdAt, embedding);

    return Number(result.lastInsertRowid);
  }

  markMemorySuperseded(memoryId: number, supersededBy: number | null, now: string): void {
    this.connection
      .prepare(
        `UPDATE memory_items
         SET status = 'superseded',
             superseded_by = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(supersededBy, now, memoryId);
  }

  updateMemoryEmbedding(memoryId: number, embedding: Buffer | null, now: string): void {
    this.connection
      .prepare("UPDATE memory_items SET embedding = ?, updated_at = ? WHERE id = ?")
      .run(embedding, now, memoryId);
  }

  listActiveMemories(): MemoryItem[] {
    return this.connection
      .prepare(
        `SELECT
           id,
           category,
           summary,
           details,
           source_block AS sourceBlock,
           source_chat AS sourceChat,
           created_at AS createdAt,
           updated_at AS updatedAt,
           status,
           superseded_by AS supersededBy,
           embedding
         FROM memory_items
         WHERE status = 'active'
         ORDER BY updated_at DESC`
      )
      .all() as MemoryItem[];
  }

  findActiveMemoryByNormalizedKey(
    category: MemoryCategory,
    normalizedSummary: string,
    normalizedDetails: string
  ): Pick<MemoryItem, "id" | "category" | "summary" | "details"> | null {
    const row = this.connection
      .prepare(
        `SELECT id, category, summary, details
         FROM memory_items
         WHERE status = 'active'
           AND category = ?
           AND trim(lower(summary)) = ?
           AND trim(lower(coalesce(details, ''))) = ?
         LIMIT 1`
      )
      .get(category, normalizedSummary, normalizedDetails) as Pick<MemoryItem, "id" | "category" | "summary" | "details"> | undefined;

    return row ?? null;
  }

  searchActiveMemoriesByEmbedding(queryEmbedding: number[], limit: number, candidateLimit: number): RetrievedMemory[] {
    const memories = this.connection
      .prepare(
        `SELECT id, category, summary, details, embedding
         FROM memory_items
         WHERE status = 'active'
           AND embedding IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(candidateLimit) as Array<Pick<MemoryItem, "id" | "category" | "summary" | "details" | "embedding">>;

    return memories
      .map((memory) => ({
        id: memory.id,
        category: memory.category,
        summary: memory.summary,
        details: memory.details,
        score: cosineSimilarity(queryEmbedding, decodeEmbedding(memory.embedding!))
      }))
      .filter((memory) => Number.isFinite(memory.score))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  searchMemoriesForForget(query: string, limit: number): Array<{ id: number; summary: string; details: string | null }> {
    return this.connection
      .prepare(
        `SELECT id, summary, details
         FROM memory_items
         WHERE status = 'active'
           AND (summary LIKE ? OR details LIKE ?)
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit) as Array<{ id: number; summary: string; details: string | null }>;
  }

  searchArchivedMessages(query: string, limit: number): ArchiveHit[] {
    return this.connection
      .prepare(
        `SELECT
           messages.id AS messageId,
           messages.chat_id AS chatId,
           messages.block_id AS blockId,
           chats.jid AS chatJid,
           messages.sender_jid AS senderJid,
           trim(coalesce(messages.text, '') || CASE WHEN messages.image_description IS NOT NULL THEN ' [image] ' || messages.image_description ELSE '' END) AS text,
           messages.created_at AS createdAt
         FROM messages_fts
         JOIN messages ON messages.id = messages_fts.rowid
         JOIN chats ON chats.id = messages.chat_id
         JOIN blocks ON blocks.id = messages.block_id
         WHERE messages_fts MATCH ?
           AND blocks.status != 'open'
         ORDER BY bm25(messages_fts)
         LIMIT ?`
      )
      .all(query, limit) as ArchiveHit[];
  }

  listActiveMemoryIds(): number[] {
    const rows = this.connection
      .prepare("SELECT id FROM memory_items WHERE status = 'active' ORDER BY id ASC")
      .all() as Array<{ id: number }>;

    return rows.map((row) => row.id);
  }

  getMemory(memoryId: number): MemoryItem | null {
    const row = this.connection
      .prepare(
        `SELECT
           id,
           category,
           summary,
           details,
           source_block AS sourceBlock,
           source_chat AS sourceChat,
           created_at AS createdAt,
           updated_at AS updatedAt,
           status,
           superseded_by AS supersededBy,
           embedding
         FROM memory_items
         WHERE id = ?`
      )
      .get(memoryId) as MemoryItem | undefined;

    return row ?? null;
  }

  listPrunableMedia(): Array<{ id: number; filePath: string }> {
    return this.connection
      .prepare(
        `SELECT media.id AS id, media.file_path AS filePath
         FROM media
         JOIN messages ON messages.id = media.message_id
         JOIN blocks ON blocks.id = messages.block_id
         WHERE media.status IN ('described', 'failed')
           AND blocks.status IN ('done', 'failed')`
      )
      .all() as Array<{ id: number; filePath: string }>;
  }

  compactRawPayloadsForBlock(blockId: number): number {
    const result = this.connection
      .prepare(
        `UPDATE messages
         SET raw_json = ?
         WHERE block_id = ?
           AND raw_json != ?`
      )
      .run(COMPACTED_RAW_JSON, blockId, COMPACTED_RAW_JSON);

    return result.changes;
  }

  markMediaPruned(mediaId: number, now: string): void {
    this.connection
      .prepare(
        `UPDATE media
         SET status = 'pruned',
             updated_at = ?,
             pruned_at = ?
         WHERE id = ?`
      )
      .run(now, now, mediaId);
  }
}

function toLunaDbOpenError(dbPath: string, cause: unknown): LunaDbOpenError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const normalized = detail.toLowerCase();
  const isCorruptionLike =
    normalized.includes("file is not a database") ||
    normalized.includes("database disk image is malformed") ||
    normalized.includes("malformed");

  if (isCorruptionLike) {
    return new LunaDbOpenError(
      `SQLite database at ${dbPath} appears corrupt or unreadable. Restore bot.db from a backup, or move/remove it to let Luna create a fresh database. Original error: ${detail}`,
      { cause }
    );
  }

  return new LunaDbOpenError(
    `Unable to open SQLite database at ${dbPath}. Check file permissions, free disk space, and the parent directory. Original error: ${detail}`,
    { cause }
  );
}

export function encodeEmbedding(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

export function decodeEmbedding(buffer: Buffer): number[] {
  const array = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / Float32Array.BYTES_PER_ELEMENT));
  return Array.from(array);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return Number.NaN;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) {
      return Number.NaN;
    }

    dot += leftValue * rightValue;
    leftMagnitude += leftValue ** 2;
    rightMagnitude += rightValue ** 2;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return Number.NaN;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}
