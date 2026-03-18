export type ChatType = "dm" | "group";
export type ContentType = "text" | "image" | "system";
export type BlockStatus = "open" | "queued" | "running" | "done" | "failed";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type JobType = "extract_block" | "reindex" | "prune_media";
export type MemoryCategory =
  | "person"
  | "preference"
  | "relationship"
  | "running_joke"
  | "event"
  | "fact";
export type MemoryStatus = "active" | "superseded";

export interface ModelLanes {
  main: string;
  extract: string;
  vision: string;
  embed: string;
}

export interface BotReplyWhitelist {
  dms?: string[];
  groups?: string[];
}

export interface BotHeartbeatConfig {
  intervalMs?: number;
  randomIntervalMs?: [number, number];
  batchSize?: number;
}

export interface ResolvedReplyWhitelist {
  dms: string[] | null;
  groups: string[] | null;
}

export interface ResolvedHeartbeatConfig {
  enabled: boolean;
  intervalMs: number | null;
  randomIntervalMs: [number, number] | null;
  batchSize: number;
}

export interface RootConfig {
  openRouterBaseUrl: string;
  models: ModelLanes;
  defaultBlockSize: number;
  defaultBubbleDelayMs: readonly [number, number];
  defaultRetrievalMinHits: number;
  defaultHeartbeatBatchSize: number;
  memorySearchLimit: number;
  rawArchiveSearchLimit: number;
  recentWindowBlockLimit: number;
  recentWindowMessageLimit: number;
  busyTimeoutMs: number;
  workerPollIntervalMs: number;
  staleJobAfterMs: number;
  bubbleTypingBaseMs: number;
  inlineForgetSearchLimit: number;
}

export interface BotFileConfig {
  botId: string;
  triggerNames: string[];
  admins: string[];
  messagePrefix?: string;
  replyWhitelist?: BotReplyWhitelist;
  heartbeat?: BotHeartbeatConfig;
  blockSize?: number;
  bubbleDelayMs?: [number, number];
  retrievalMinHits?: number;
  models?: Partial<ModelLanes>;
  retainProcessedMedia?: boolean;
}

export interface ResolvedBotConfig {
  botId: string;
  triggerNames: string[];
  admins: string[];
  messagePrefix: string;
  replyWhitelist: ResolvedReplyWhitelist;
  heartbeat: ResolvedHeartbeatConfig;
  blockSize: number;
  bubbleDelayMs: [number, number];
  retrievalMinHits: number;
  models: ModelLanes;
  retainProcessedMedia: boolean;
}

export interface RuntimePaths {
  botPath: string;
  personaPath: string;
  botConfigPath: string;
  heartbeatPath: string;
  dbPath: string;
  authDir: string;
  mediaDir: string;
  logsDir: string;
}

export interface RuntimeContext {
  rootConfig: RootConfig;
  botConfig: ResolvedBotConfig;
  persona: string;
  heartbeatInstructions: string | null;
  paths: RuntimePaths;
}

export interface TriggerDecision {
  triggered: boolean;
  reason: "dm" | "reply" | "mention" | "trigger_name" | null;
}

export interface NormalizedMessage {
  externalId: string;
  chatJid: string;
  chatType: ChatType;
  senderJid: string;
  senderName: string | null;
  isFromBot: boolean;
  timestamp: string;
  contentType: ContentType;
  text: string | null;
  mentions: string[];
  quotedExternalId: string | null;
  rawJson: string;
  image:
    | {
        buffer: Buffer;
        mimeType: string;
        caption: string | null;
      }
    | null;
}

export interface StoredMessage {
  id: number;
  chatId: number;
  blockId: number | null;
  externalId: string;
  senderJid: string;
  senderName: string | null;
  isFromBot: boolean;
  chatType: ChatType;
  contextOnly: boolean;
  memoryEligible: boolean;
  wasTriggered: boolean;
  turnEligible: boolean;
  contentType: ContentType;
  text: string | null;
  imageDescription: string | null;
  quotedExternalId: string | null;
  mentions: string[];
  createdAt: string;
  processedTurnAt: string | null;
}

export interface MemoryItem {
  id: number;
  category: MemoryCategory;
  summary: string;
  details: string | null;
  sourceBlock: number | null;
  sourceChat: number | null;
  createdAt: string;
  updatedAt: string;
  status: MemoryStatus;
  supersededBy: number | null;
  embedding: Buffer | null;
}

export interface RetrievedMemory {
  id: number;
  category: MemoryCategory;
  summary: string;
  details: string | null;
  score: number;
}

export interface ArchiveHit {
  messageId: number;
  chatId: number;
  blockId: number | null;
  chatJid: string;
  senderJid: string;
  text: string;
  createdAt: string;
}

export interface ExtractionCandidate {
  id: number;
  senderJid: string;
  isFromBot: boolean;
  text: string | null;
  imageDescription: string | null;
  createdAt: string;
}

export interface GeneratedReply {
  reply: string;
  memoryOperations: MemoryOperation[];
}

export interface GeneratedHeartbeatDecision {
  shouldReply: boolean;
  reply: string;
  memoryOperations: MemoryOperation[];
}

export type MemoryOperation =
  | {
      type: "remember";
      category: MemoryCategory;
      summary: string;
      details?: string | undefined;
    }
  | {
      type: "forget";
      query: string;
    };

export interface ExtractedMemory {
  category: MemoryCategory;
  summary: string;
  details?: string | undefined;
}
