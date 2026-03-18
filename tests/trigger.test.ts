import { describe, expect, it } from "vitest";

import { detectTrigger } from "../src/chat/trigger.js";

describe("detectTrigger", () => {
  it("responds to every inbound DM", () => {
    expect(
      detectTrigger({
        chatType: "dm",
        isFromBot: false,
        text: "hello",
        mentions: [],
        botJids: ["bot@s.whatsapp.net"],
        triggerNames: ["maya"],
        isDirectReplyToBot: false
      })
    ).toEqual({
      triggered: true,
      reason: "dm"
    });
  });

  it("handles reply, mention, and text triggers in groups", () => {
    expect(
      detectTrigger({
        chatType: "group",
        isFromBot: false,
        text: "ambient",
        mentions: [],
        botJids: ["bot@s.whatsapp.net"],
        triggerNames: ["maya"],
        isDirectReplyToBot: true
      }).reason
    ).toBe("reply");

    expect(
      detectTrigger({
        chatType: "group",
        isFromBot: false,
        text: "ambient",
        mentions: ["bot@s.whatsapp.net"],
        botJids: ["bot@s.whatsapp.net"],
        triggerNames: ["maya"],
        isDirectReplyToBot: false
      }).reason
    ).toBe("mention");

    expect(
      detectTrigger({
        chatType: "group",
        isFromBot: false,
        text: "Hey MAYA can you help?",
        mentions: [],
        botJids: ["bot@s.whatsapp.net"],
        triggerNames: ["maya"],
        isDirectReplyToBot: false
      }).reason
    ).toBe("trigger_name");
  });

  it("matches mentions against lid and phone identities for the same bot user", () => {
    expect(
      detectTrigger({
        chatType: "group",
        isFromBot: false,
        text: "@maya",
        mentions: ["201408833953893@lid"],
        botJids: ["393444553282@s.whatsapp.net", "201408833953893@lid"],
        triggerNames: ["maya"],
        isDirectReplyToBot: false
      }).reason
    ).toBe("mention");
  });

  it("matches Telegram mentions by exact identity only", () => {
    expect(
      detectTrigger({
        chatType: "group",
        isFromBot: false,
        text: "hello there",
        mentions: ["tg:user:42"],
        botJids: ["tg:user:42"],
        triggerNames: ["maya"],
        isDirectReplyToBot: false
      }).reason
    ).toBe("mention");

    expect(
      detectTrigger({
        chatType: "group",
        isFromBot: false,
        text: "hello there",
        mentions: ["tg:user:42"],
        botJids: ["tg:user:99"],
        triggerNames: ["maya"],
        isDirectReplyToBot: false
      }).reason
    ).toBeNull();
  });

  it("ignores ambient group chatter", () => {
    expect(
      detectTrigger({
        chatType: "group",
        isFromBot: false,
        text: "just chatting",
        mentions: [],
        botJids: ["bot@s.whatsapp.net"],
        triggerNames: ["maya"],
        isDirectReplyToBot: false
      })
    ).toEqual({
      triggered: false,
      reason: null
    });
  });
});
