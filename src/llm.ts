import { z } from "zod";

import type {
  ExtractedMemory,
  GeneratedHeartbeatDecision,
  GeneratedReply,
  ModelLanes,
  StoredMessage
} from "./domain.js";
import type { Logger } from "./logging.js";
import { tryParseJson } from "./utils.js";

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
    .map((message) => [message.text, message.imageDescription].filter(Boolean).join(" ").trim())
    .filter(Boolean)
    .join("\n");

  return INLINE_MEMORY_OPERATION_PATTERN.test(text);
}

export class OpenRouterGateway implements LanguageGateway {
  private readonly embedCache = new Map<string, number[]>();

  private readonly maxEmbedCacheEntries = 256;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly models: ModelLanes,
    private readonly logger?: Logger
  ) {}

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
      formatMessages(input.recentWindow),
      "",
      "New inbound turn messages (this is what Maya is replying to right now):",
      formatMessages(input.pendingMessages)
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
              "- Stay in character and produce a natural WhatsApp reply.",
              "- Reply in plain text only.",
              "- Do not use markdown fences or JSON.",
              "- Keep the response natural and human-sized for WhatsApp.",
              "- Use the speaker names and recent window to stay grounded in the actual conversation."
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
            "- Stay in character and produce a natural WhatsApp reply in reply.",
            "- reply must be plain text only, with no markdown fences.",
            "- If an admin explicitly asks to remember or forget something, include the matching memoryOperations and comply.",
            "- If a non-admin asks to remember or forget something, decide if it is appropriate before adding memoryOperations.",
            "- Keep memoryOperations atomic and sparse. Use them only for explicit remember/forget actions.",
            "- Use the speaker names and recent window to stay grounded in the actual conversation."
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
    chatType: "dm" | "group";
    recentWindow: StoredMessage[];
    retrievedMemoryBlock: string;
    archiveFallbackBlock: string;
    reviewMessages: StoredMessage[];
    adminSenders: string[];
  }): Promise<GeneratedHeartbeatDecision> {
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
            "- Set shouldReply to false when Maya should stay silent after checking the chat.",
            '- When shouldReply is false, set reply to "".',
            "- When shouldReply is true, reply must be plain text only, with no markdown fences.",
            "- If an admin explicitly asks to remember or forget something, include the matching memoryOperations and comply.",
            "- If a non-admin asks to remember or forget something, decide if it is appropriate before adding memoryOperations.",
            "- Keep memoryOperations atomic and sparse. Use them only for explicit remember/forget actions.",
            "- Stay selective. Do not jump into every conversation just because a heartbeat fired.",
            "- Use the speaker names and recent context to stay grounded in the real conversation."
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
            formatMessages(input.recentWindow),
            "",
            "Messages since the last review (this is what Maya is checking right now):",
            formatMessages(input.reviewMessages)
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
                "Describe this inbound WhatsApp image for conversational context.",
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
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.models.embed,
        input: text
      })
    });

    if (!response.ok) {
      throw new Error(`OpenRouter embeddings failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
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
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        ...(structured ? { response_format: { type: "json_object" } } : {}),
        messages
      })
    });

    if (!response.ok) {
      throw new Error(`OpenRouter chat completion failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };

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

function formatMessages(messages: StoredMessage[]): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages
    .map((message) => {
      const speaker = message.isFromBot ? "Maya" : (message.senderName?.trim() || message.senderJid);
      const prefixes: string[] = [];
      if (!message.isFromBot && message.contextOnly) {
        prefixes.push("ambient");
      }
      if (!message.isFromBot && message.wasTriggered) {
        prefixes.push("triggered");
      }
      const text = [message.text, message.imageDescription ? `[image] ${message.imageDescription}` : null]
        .filter(Boolean)
        .join(" ")
        .trim();
      const prefix = prefixes.length > 0 ? `[${prefixes.join(", ")}] ` : "";
      return `${prefix}${speaker}: ${text || "(empty)"}`;
    })
    .join("\n");
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
