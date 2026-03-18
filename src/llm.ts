import { z } from "zod";

import type {
  ExtractedMemory,
  GeneratedHeartbeatDecision,
  GeneratedReply,
  ModelLanes,
  StoredMessage
} from "./domain.js";
import type { Logger } from "./logging.js";
import { formatMessageContent } from "./message-content.js";
import { sanitizeGeneratedBubble } from "./output.js";
import { sleep, tryParseJson } from "./utils.js";

const MemoryOperationSchema = z.union([
  z.object({
    type: z.literal("remember"),
    category: z.enum(["person", "preference", "relationship", "running_joke", "event", "fact"]),
    summary: z.string().trim().min(1),
    details: z.string().trim().optional()
  }),
  z.object({
    type: z.literal("forget"),
    query: z.string().trim().min(1)
  })
]);

const GeneratedReplySchema = z.object({
  reply: z.string().trim().min(1),
  memoryOperations: z.array(MemoryOperationSchema).default([])
});

const GeneratedHeartbeatDecisionSchema = z.object({
  shouldReply: z.boolean(),
  reply: z.string().default(""),
  memoryOperations: z.array(MemoryOperationSchema).default([])
});

const ExtractedMemorySchema = z.object({
  memories: z
    .array(
      z.object({
        category: z.enum(["person", "preference", "relationship", "running_joke", "event", "fact"]),
        summary: z.string().trim().min(1),
        details: z.string().trim().optional()
      })
    )
    .default([])
});

const INLINE_MEMORY_OPERATION_PATTERN =
  /\b(remember|forget|forgot|dont forget|don't forget|erase that|wipe that|remove that)\b/i;

const RETRYABLE_OPENROUTER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

interface OpenRouterRequestPolicy {
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

const defaultOpenRouterRequestPolicy: OpenRouterRequestPolicy = {
  timeoutMs: 20_000,
  maxRetries: 2,
  retryBaseDelayMs: 500
};

type OpenRouterMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "user";
      content: Array<
        | {
            type: "text";
            text: string;
          }
        | {
            type: "image_url";
            image_url: {
              url: string;
            };
          }
      >;
    };

export interface LanguageGateway {
  generateReply(input: {
    persona: string;
    botId: string;
    messagePrefix: string;
    chatType: "dm" | "group";
    recentWindow: StoredMessage[];
    retrievedMemoryBlock: string;
    archiveFallbackBlock: string;
    pendingMessages: StoredMessage[];
    adminSenders: string[];
  }): Promise<GeneratedReply>;
  generateHeartbeatDecision(input: {
    persona: string;
    heartbeatInstructions: string;
    botId: string;
    messagePrefix: string;
    chatType: "dm" | "group";
    recentWindow: StoredMessage[];
    retrievedMemoryBlock: string;
    archiveFallbackBlock: string;
    reviewMessages: StoredMessage[];
    adminSenders: string[];
  }): Promise<GeneratedHeartbeatDecision>;
  extractMemories(input: {
    persona: string;
    botId: string;
    messages: Array<{ senderJid: string; isFromBot: boolean; text: string }>;
  }): Promise<ExtractedMemory[]>;
  describeImage(input: { buffer: Buffer; mimeType: string; caption: string | null }): Promise<string>;
  embedText(text: string): Promise<number[]>;
}

export function shouldUseStructuredReplyMode(pendingMessages: StoredMessage[]): boolean {
  const text = pendingMessages
    .map((message) => formatMessageContent(message))
    .filter(Boolean)
    .join("\n");

  return INLINE_MEMORY_OPERATION_PATTERN.test(text);
}

export class OpenRouterGateway implements LanguageGateway {
  private readonly embedCache = new Map<string, number[]>();

  private readonly maxEmbedCacheEntries = 256;

  private readonly requestPolicy: OpenRouterRequestPolicy;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly models: ModelLanes,
    private readonly logger?: Logger,
    requestPolicy: Partial<OpenRouterRequestPolicy> = {}
  ) {
    this.requestPolicy = {
      ...defaultOpenRouterRequestPolicy,
      ...requestPolicy
    };
  }

  async generateReply(input: {
    persona: string;
    botId: string;
    messagePrefix: string;
    chatType: "dm" | "group";
    recentWindow: StoredMessage[];
    retrievedMemoryBlock: string;
    archiveFallbackBlock: string;
    pendingMessages: StoredMessage[];
    adminSenders: string[];
  }): Promise<GeneratedReply> {
    const botLabel = input.botId.trim() || "bot";
    const structuredReplyMode = shouldUseStructuredReplyMode(input.pendingMessages);
    const userMessage = [
      `Chat type: ${input.chatType}`,
      `Bot id: ${input.botId}`,
      `Admin senders in this turn: ${input.adminSenders.length > 0 ? input.adminSenders.join(", ") : "none"}`,
      "",
      "Retrieved memories:",
      input.retrievedMemoryBlock || "(none)",
      "",
      "Archive fallback:",
      input.archiveFallbackBlock || "(none)",
      "",
      "Recent window (chronological context before the current turn; [ambient] means background group chatter):",
      formatMessages(input.recentWindow, botLabel, input.messagePrefix),
      "",
      `New inbound turn messages (this is what ${botLabel} is replying to right now):`,
      formatMessages(input.pendingMessages, botLabel, input.messagePrefix)
    ].join("\n");

    if (!structuredReplyMode) {
      const response = await this.chatCompletion(
        "main",
        this.models.main,
        [
          {
            role: "system",
            content: [
              input.persona,
              "",
              "Rules:",
              "- Stay in character and produce a natural chat reply.",
              "- Reply in plain text only.",
              "- Do not use markdown fences or JSON.",
              "- Keep the response natural and human-sized for chat.",
              "- Use the speaker names and recent window to stay grounded in the actual conversation.",
              ...buildImageContextRules(),
              ...buildRawReplyRules(input.botId, input.messagePrefix)
            ].join("\n")
          },
          {
            role: "user",
            content: userMessage
          }
        ],
        false
      );

      return GeneratedReplySchema.parse({
        reply: response.trim(),
        memoryOperations: []
      });
    }

    const response = await this.chatCompletion(
      "main",
      this.models.main,
      [
        {
          role: "system",
          content: [
            input.persona,
            "",
            "Return strict JSON with shape:",
            '{"reply":"string","memoryOperations":[{"type":"remember","category":"fact","summary":"string","details":"string?"},{"type":"forget","query":"string"}]}',
            "",
            "Rules:",
            "- Stay in character and produce a natural chat reply in reply.",
            "- reply must be plain text only, with no markdown fences.",
            "- If an admin explicitly asks to remember or forget something, include the matching memoryOperations and comply.",
            "- If a non-admin asks to remember or forget something, decide if it is appropriate before adding memoryOperations.",
            "- Keep memoryOperations atomic and sparse. Use them only for explicit remember/forget actions.",
            "- Use the speaker names and recent window to stay grounded in the actual conversation.",
            ...buildImageContextRules(),
            ...buildRawReplyRules(input.botId, input.messagePrefix)
          ].join("\n")
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      true
    );

    return GeneratedReplySchema.parse(parseLooseJson(response));
  }

  async generateHeartbeatDecision(input: {
    persona: string;
    heartbeatInstructions: string;
    botId: string;
    messagePrefix: string;
    chatType: "dm" | "group";
    recentWindow: StoredMessage[];
    retrievedMemoryBlock: string;
    archiveFallbackBlock: string;
    reviewMessages: StoredMessage[];
    adminSenders: string[];
  }): Promise<GeneratedHeartbeatDecision> {
    const botLabel = input.botId.trim() || "bot";
    const response = await this.chatCompletion(
      "main",
      this.models.main,
      [
        {
          role: "system",
          content: [
            input.persona,
            "",
            "Heartbeat instructions:",
            input.heartbeatInstructions || "(none)",
            "",
            "Return strict JSON with shape:",
            '{"shouldReply":true,"reply":"string","memoryOperations":[{"type":"remember","category":"fact","summary":"string","details":"string?"},{"type":"forget","query":"string"}]}',
            "",
            "Rules:",
            "- Use the heartbeat instructions to decide whether to say anything at all.",
            `- Set shouldReply to false when ${botLabel} should stay silent after checking the chat.`,
            '- When shouldReply is false, set reply to "".',
            "- When shouldReply is true, reply must be plain text only, with no markdown fences.",
            "- If an admin explicitly asks to remember or forget something, include the matching memoryOperations and comply.",
            "- If a non-admin asks to remember or forget something, decide if it is appropriate before adding memoryOperations.",
            "- Keep memoryOperations atomic and sparse. Use them only for explicit remember/forget actions.",
            "- Stay selective. Do not jump into every conversation just because a heartbeat fired.",
            "- Use the speaker names and recent context to stay grounded in the real conversation.",
            ...buildImageContextRules(),
            ...buildRawReplyRules(input.botId, input.messagePrefix)
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Chat type: ${input.chatType}`,
            `Bot id: ${input.botId}`,
            `Admin senders in this heartbeat: ${input.adminSenders.length > 0 ? input.adminSenders.join(", ") : "none"}`,
            "",
            "Retrieved memories:",
            input.retrievedMemoryBlock || "(none)",
            "",
            "Archive fallback:",
            input.archiveFallbackBlock || "(none)",
            "",
            "Recent window (chronological context before the current heartbeat review):",
            formatMessages(input.recentWindow, botLabel, input.messagePrefix),
            "",
            `Messages since the last review (this is what ${botLabel} is checking right now):`,
            formatMessages(input.reviewMessages, botLabel, input.messagePrefix)
          ].join("\n")
        }
      ],
      true
    );

    return GeneratedHeartbeatDecisionSchema.parse(parseLooseJson(response));
  }

  async extractMemories(input: {
    persona: string;
    botId: string;
    messages: Array<{ senderJid: string; isFromBot: boolean; text: string }>;
  }): Promise<ExtractedMemory[]> {
    const response = await this.chatCompletion(
      "extract",
      this.models.extract,
      [
        {
          role: "system",
          content: [
            "Extract durable atomic memories from the conversation.",
            "Return strict JSON with shape:",
            '{"memories":[{"category":"fact","summary":"string","details":"string?"}]}',
            "Only include facts worth remembering long term.",
            "Do not include duplicates.",
            "Use only categories: person, preference, relationship, running_joke, event, fact."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Bot id: ${input.botId}`,
            "",
            "Conversation:",
            input.messages
              .map((message) => `${message.isFromBot ? "bot" : message.senderJid}: ${message.text}`)
              .join("\n")
          ].join("\n")
        }
      ],
      true
    );

    return ExtractedMemorySchema.parse(parseLooseJson(response)).memories;
  }

  async describeImage(input: { buffer: Buffer; mimeType: string; caption: string | null }): Promise<string> {
    const dataUrl = `data:${input.mimeType};base64,${input.buffer.toString("base64")}`;
    const response = await this.chatCompletion(
      "vision",
      this.models.vision,
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Describe this inbound image for conversational context.",
                "Keep it concise and factual.",
                input.caption ? `User caption: ${input.caption}` : ""
              ]
                .filter(Boolean)
                .join("\n")
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl
              }
            }
          ]
        }
      ],
      false
    );

    return response.trim();
  }

  async embedText(text: string): Promise<number[]> {
    const cached = this.embedCache.get(text);
    if (cached) {
      this.logger?.info("openrouter embedding cache hit", {
        lane: "embed",
        model: this.models.embed,
        textLength: text.length
      });
      return [...cached];
    }

    const startedAt = Date.now();
    const payload = await this.requestJson<{
      data?: Array<{ embedding?: number[] }>;
    }>({
      lane: "embed",
      model: this.models.embed,
      path: "/embeddings",
      body: {
        model: this.models.embed,
        input: text
      }
    });
    const embedding = payload.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error("OpenRouter embeddings response did not include an embedding vector.");
    }

    this.setEmbedCache(text, embedding);
    this.logger?.info("openrouter embedding completed", {
      lane: "embed",
      model: this.models.embed,
      textLength: text.length,
      durationMs: Date.now() - startedAt
    });

    return embedding;
  }

  private async chatCompletion(
    lane: keyof ModelLanes,
    model: string,
    messages: OpenRouterMessage[],
    structured: boolean
  ): Promise<string> {
    const startedAt = Date.now();
    const payload = await this.requestJson<{
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    }>({
      lane,
      model,
      path: "/chat/completions",
      body: {
        model,
        ...(structured ? { response_format: { type: "json_object" } } : {}),
        messages
      }
    });

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenRouter response did not contain a message.");
    }

    if (typeof content === "string") {
      this.logger?.info("openrouter chat completion completed", {
        lane,
        model,
        structured,
        durationMs: Date.now() - startedAt,
        responseChars: content.length
      });
      return content;
    }

    const text = content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();

    this.logger?.info("openrouter chat completion completed", {
      lane,
      model,
      structured,
      durationMs: Date.now() - startedAt,
      responseChars: text.length
    });

    return text;
  }

  private async requestJson<T>(input: {
    lane: keyof ModelLanes | "embed";
    model: string;
    path: "/chat/completions" | "/embeddings";
    body: unknown;
  }): Promise<T> {
    for (let attempt = 0; attempt <= this.requestPolicy.maxRetries; attempt += 1) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
      }, this.requestPolicy.timeoutMs);
      timeout.unref?.();

      try {
        const response = await fetch(`${this.baseUrl}${input.path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(input.body),
          signal: abortController.signal
        });

        if (!response.ok) {
          const bodyText = await safeReadResponseText(response);
          const errorMessage = formatOpenRouterHttpError(input.path, response.status, bodyText, response.headers);
          if (attempt < this.requestPolicy.maxRetries && RETRYABLE_OPENROUTER_STATUSES.has(response.status)) {
            await this.retryOpenRouterRequest(input, attempt, errorMessage);
            continue;
          }
          throw new Error(errorMessage);
        }

        return (await response.json()) as T;
      } catch (error) {
        if (attempt < this.requestPolicy.maxRetries && isRetryableOpenRouterError(error)) {
          await this.retryOpenRouterRequest(input, attempt, describeOpenRouterFailure(error, this.requestPolicy.timeoutMs));
          continue;
        }

        if (error instanceof Error) {
          throw error;
        }

        throw new Error(String(error));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(`OpenRouter ${input.path} request exhausted all retries.`);
  }

  private async retryOpenRouterRequest(
    input: { lane: keyof ModelLanes | "embed"; model: string; path: string },
    attempt: number,
    reason: string
  ): Promise<void> {
    const delayMs = this.getRetryDelayMs(attempt);
    this.logger?.warn("openrouter request failed, retrying", {
      lane: input.lane,
      model: input.model,
      path: input.path,
      attempt: attempt + 1,
      retryDelayMs: delayMs,
      reason
    });
    await sleep(delayMs);
  }

  private getRetryDelayMs(attempt: number): number {
    const baseDelayMs = this.requestPolicy.retryBaseDelayMs * 2 ** attempt;
    return baseDelayMs + Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs / 4)));
  }

  private setEmbedCache(text: string, embedding: number[]): void {
    if (this.embedCache.size >= this.maxEmbedCacheEntries) {
      const oldestKey = this.embedCache.keys().next().value;
      if (typeof oldestKey === "string") {
        this.embedCache.delete(oldestKey);
      }
    }

    this.embedCache.set(text, [...embedding]);
  }
}

function isRetryableOpenRouterError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error instanceof TypeError;
}

function describeOpenRouterFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return `request timed out after ${timeoutMs}ms`;
    }

    return error.message;
  }

  return String(error);
}

function formatOpenRouterHttpError(path: string, status: number, bodyText: string, headers: Headers): string {
  const detail = extractOpenRouterErrorDetail(bodyText);
  const requestId = headers.get("x-request-id") ?? headers.get("request-id") ?? headers.get("cf-ray");
  const parts = [`OpenRouter ${path} failed with status ${status}.`];

  if (detail) {
    parts.push(`Detail: ${detail}`);
  } else if (bodyText) {
    parts.push(`Body: ${truncateForError(bodyText, 240)}`);
  }

  if (requestId) {
    parts.push(`Request ID: ${requestId}`);
  }

  return parts.join(" ").trim();
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function truncateForError(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function extractOpenRouterErrorDetail(bodyText: string): string {
  if (!bodyText) {
    return "";
  }

  const parsed = tryParseJson<Record<string, unknown>>(bodyText);
  if (!parsed) {
    return truncateForError(bodyText, 240);
  }

  const detailCandidates: unknown[] = [
    parsed.error,
    parsed.message,
    parsed.detail,
    parsed.provider_error,
    parsed.providerError
  ];

  for (const candidate of detailCandidates) {
    const detail = extractStringDetail(candidate);
    if (detail) {
      return truncateForError(detail, 240);
    }
  }

  return truncateForError(bodyText, 240);
}

function extractStringDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const nested = [
    record.message,
    record.detail,
    record.raw,
    record.provider_message,
    record.providerMessage
  ];

  for (const candidate of nested) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return "";
}

function formatMessages(messages: StoredMessage[], botLabel: string, messagePrefix: string): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages
    .map((message) => {
      const speaker = message.isFromBot ? botLabel : (message.senderName?.trim() || message.senderJid);
      const prefixes: string[] = [];
      if (!message.isFromBot && message.contextOnly) {
        prefixes.push("ambient");
      }
      if (!message.isFromBot && message.wasTriggered) {
        prefixes.push("triggered");
      }
      const rawText = formatMessageContent(message);
      const text = message.isFromBot
        ? sanitizeGeneratedBubble(rawText, {
            botId: botLabel,
            messagePrefix
          })
        : rawText;
      const prefix = prefixes.length > 0 ? `[${prefixes.join(", ")}] ` : "";
      return `${prefix}${speaker}: ${text || "(empty)"}`;
    })
    .join("\n");
}

function buildImageContextRules(): string[] {
  return [
    '- Image attachments may appear inline as "[image] ..." when they were successfully described.',
    '- Treat "[image] ..." text as grounded context about what was in the image, and answer naturally from it.',
    '- If a message says "[image attached; description unavailable]", be honest that the image arrived but could not be inspected.',
    "- Do not claim you cannot see or inspect images when an image description is already present in context."
  ];
}

function buildRawReplyRules(botId: string, messagePrefix: string): string[] {
  const rules = [
    "- Output only the raw chat text body. Do not add a speaker label, role tag, or self-introduction.",
    "- Keep emoji usage sparse and organic. Do not stack repeated leading emojis or decorative symbols."
  ];

  const normalizedBotId = botId.trim();
  if (normalizedBotId) {
    rules.push(`- Do not start the reply with "${normalizedBotId}:" or any similar self-label.`);
  }

  const normalizedMessagePrefix = messagePrefix.trim();
  if (normalizedMessagePrefix) {
    rules.push(
      `- Do not include the outbound prefix yourself. The transport adds it after generation. Configured outbound prefix: ${JSON.stringify(messagePrefix)}.`
    );
  }

  return rules;
}

function parseLooseJson(value: string): unknown {
  const direct = tryParseJson<unknown>(value);
  if (direct) {
    return direct;
  }

  const fencedMatch = value.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fencedMatch?.[1]) {
    const parsed = tryParseJson<unknown>(fencedMatch[1]);
    if (parsed) {
      return parsed;
    }
  }

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = tryParseJson<unknown>(value.slice(firstBrace, lastBrace + 1));
    if (parsed) {
      return parsed;
    }
  }

  throw new Error("Model response was not valid JSON.");
}
