import { describe, expect, it } from "vitest";

import * as Baileys from "@whiskeysockets/baileys";

import {
  shouldIgnoreInboundProtocolMessage,
  shouldProcessUpsertType,
  shouldRequestPlaceholderResend
} from "../src/baileys.js";

describe("baileys transport helpers", () => {
  it("processes notify and append upsert events", () => {
    expect(shouldProcessUpsertType("notify")).toBe(true);
    expect(shouldProcessUpsertType("append")).toBe(true);
    expect(shouldProcessUpsertType("replace")).toBe(false);
    expect(shouldProcessUpsertType(undefined)).toBe(false);
  });

  it("requests placeholder resend for empty ciphertext stubs", () => {
    expect(
      shouldRequestPlaceholderResend({
        key: {
          id: "abc123",
          remoteJid: "39419243413568@lid",
          fromMe: false
        },
        messageStubType: Baileys.WAMessageStubType.CIPHERTEXT,
        messageStubParameters: [Baileys.NO_MESSAGE_FOUND_ERROR_TEXT]
      })
    ).toBe(true);
  });

  it("does not request placeholder resend for already retried or populated messages", () => {
    expect(
      shouldRequestPlaceholderResend(
        {
          key: {
            id: "abc123",
            remoteJid: "39419243413568@lid",
            fromMe: false
          },
          message: {
            conversation: "hello"
          },
          messageStubType: Baileys.WAMessageStubType.CIPHERTEXT
        },
        "pdo-request-1"
      )
    ).toBe(false);
  });

  it("ignores peer protocol messages emitted by placeholder resend flow", () => {
    expect(
      shouldIgnoreInboundProtocolMessage(
        {
          category: "peer"
        },
        {
          protocolMessage: {
            type: "PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE"
          }
        }
      )
    ).toBe(true);
  });
});
