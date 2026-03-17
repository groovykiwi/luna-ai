import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import type {
  GeneratedReply,
  NormalizedMessage,
  RuntimeContext,
  StoredMessage
} from "../src/domain.js";
import { TinyClawDb } from "../src/db.js";
import type { LanguageGateway } from "../src/llm.js";
import type { ChatPresenceState, ChatTransport, SendResult } from "../src/transport.js";

export function createTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "tinyclaw-"));
}

export function cleanupTempRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function createRuntimeContext(root: string): RuntimeContext {
  const botPath = path.join(root, "bot");
  const authDir = path.join(botPath, "auth");
  const mediaDir = path.join(botPath, "media");
  const logsDir = path.join(botPath, "logs");
  mkdirSync(authDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  return {
    rootConfig: {
      openRouterBaseUrl: "https://openrouter.ai/api/v1",
      models: {
        main: "main-model",
        extract: "extract-model",
        vision: "vision-model",
        embed: "embed-model"
      },
      defaultBlockSize: 50,
      defaultBubbleDelayMs: [0, 0],
      defaultRetrievalMinHits: 3,
      memorySearchLimit: 5,
      rawArchiveSearchLimit: 5,
      recentWindowBlockLimit: 2,
      recentWindowMessageLimit: 24,
      busyTimeoutMs: 5000,
      workerPollIntervalMs: 5,
      staleJobAfterMs: 60_000,
      bubbleTypingBaseMs: 0,
      inlineForgetSearchLimit: 5
    },
    botConfig: {
      botId: "maya",
      triggerNames: ["maya"],
      admins: ["admin@s.whatsapp.net"],
      replyWhitelist: {
        dms: null,
        groups: null
      },
      blockSize: 2,
      bubbleDelayMs: [0, 0],
      retrievalMinHits: 3,
      models: {
        main: "main-model",
        extract: "extract-model",
        vision: "vision-model",
        embed: "embed-model"
      },
      retainProcessedMedia: false
    },
    persona: "You are Maya.",
    paths: {
      botPath,
      personaPath: path.join(botPath, "persona.md"),
      botConfigPath: path.join(botPath, "bot.json"),
      dbPath: path.join(botPath, "bot.db"),
      authDir,
      mediaDir,
      logsDir
    }
  };
}

export function createDb(root: string): TinyClawDb {
  const runtime = createRuntimeContext(root);
  return new TinyClawDb(runtime.paths.dbPath, runtime.rootConfig.busyTimeoutMs);
}

export class FakeGateway implements LanguageGateway {
  readonly replyInputs: Array<{
    pendingMessages: StoredMessage[];
    recentWindow: StoredMessage[];
    retrievedMemoryBlock: string;
    archiveFallbackBlock: string;
    adminSenders: string[];
  }> = [];

  readonly extractionInputs: Array<Array<{ senderJid: string; isFromBot: boolean; text: string }>> = [];

  readonly embedInputs: string[] = [];

  replyResult: GeneratedReply = {
    reply: "hi there",
    memoryOperations: []
  };

  extractionResult: Array<{ category: "fact"; summary: string; details?: string | undefined }> = [];

  describeResult = "an image";

  shouldThrowOnExtract = false;

  constructor(private readonly embeddingMap: Record<string, number[]> = {}) {}

  async generateReply(input: {
    persona: string;
    botId: string;
    chatType: "dm" | "group";
    recentWindow: StoredMessage[];
    retrievedMemoryBlock: string;
    archiveFallbackBlock: string;
    pendingMessages: StoredMessage[];
    adminSenders: string[];
  }): Promise<GeneratedReply> {
    this.replyInputs.push({
      pendingMessages: input.pendingMessages,
      recentWindow: input.recentWindow,
      retrievedMemoryBlock: input.retrievedMemoryBlock,
      archiveFallbackBlock: input.archiveFallbackBlock,
      adminSenders: input.adminSenders
    });
    return this.replyResult;
  }

  async extractMemories(input: {
    persona: string;
    botId: string;
    messages: Array<{ senderJid: string; isFromBot: boolean; text: string }>;
  }): Promise<Array<{ category: "fact"; summary: string; details?: string | undefined }>> {
    this.extractionInputs.push(input.messages);
    if (this.shouldThrowOnExtract) {
      throw new Error("extract failed");
    }
    return this.extractionResult;
  }

  async describeImage(): Promise<string> {
    return this.describeResult;
  }

  async embedText(text: string): Promise<number[]> {
    this.embedInputs.push(text);
    return this.embeddingMap[text] ?? this.embeddingMap.__default ?? [1, 0, 0];
  }
}

export class MockTransport implements ChatTransport {
  private handler: ((message: NormalizedMessage) => Promise<void>) | null = null;

  readonly sent: Array<{ chatJid: string; text: string }> = [];

  readonly presenceUpdates: Array<{ chatJid: string; state: ChatPresenceState }> = [];

  constructor(private readonly botJid = "bot@s.whatsapp.net") {}

  async start(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<{ botJid: string; botIdentityJids: string[] }> {
    this.handler = onMessage;
    return {
      botJid: this.botJid,
      botIdentityJids: [this.botJid, "201408833953893@lid"]
    };
  }

  async push(message: NormalizedMessage): Promise<void> {
    if (!this.handler) {
      throw new Error("transport not started");
    }
    await this.handler(message);
  }

  async sendText(chatJid: string, text: string): Promise<SendResult> {
    this.sent.push({ chatJid, text });
    return {
      externalId: `out-${this.sent.length}`,
      timestamp: new Date().toISOString()
    };
  }

  async updatePresence(chatJid: string, state: ChatPresenceState): Promise<void> {
    this.presenceUpdates.push({ chatJid, state });
  }

  async stop(): Promise<void> {}
}

export function makeIncomingMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    externalId: overrides.externalId ?? `msg-${Math.random()}`,
    chatJid: overrides.chatJid ?? "123@s.whatsapp.net",
    chatType: overrides.chatType ?? "dm",
    senderJid: overrides.senderJid ?? "123@s.whatsapp.net",
    senderName: overrides.senderName ?? "User",
    isFromBot: overrides.isFromBot ?? false,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    contentType: overrides.contentType ?? "text",
    text: overrides.text ?? "hello",
    mentions: overrides.mentions ?? [],
    quotedExternalId: overrides.quotedExternalId ?? null,
    rawJson: overrides.rawJson ?? "{}",
    image: overrides.image ?? null
  };
}

export async function waitFor(check: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("waitFor timed out");
}
