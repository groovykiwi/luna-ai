import { areJidsSameUser } from "@whiskeysockets/baileys";

import type { TriggerDecision } from "../domain.js";
import { escapeRegExp } from "../utils.js";

function containsTriggerName(text: string, triggerNames: string[]): boolean {
  return triggerNames.some((name) => {
    const normalized = name.trim();
    if (!normalized) {
      return false;
    }

    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalized)}($|[^\\p{L}\\p{N}])`, "iu");
    return pattern.test(text);
  });
}

export function detectTrigger(options: {
  chatType: "dm" | "group";
  isFromBot: boolean;
  text: string | null;
  mentions: string[];
  botJids: string[];
  triggerNames: string[];
  isDirectReplyToBot: boolean;
}): TriggerDecision {
  if (options.isFromBot) {
    return {
      triggered: false,
      reason: null
    };
  }

  if (options.chatType === "dm") {
    return {
      triggered: true,
      reason: "dm"
    };
  }

  if (options.isDirectReplyToBot) {
    return {
      triggered: true,
      reason: "reply"
    };
  }

  if (
    options.mentions.some((mentionJid) =>
      options.botJids.some((botJid) => areJidsSameUser(mentionJid, botJid))
    )
  ) {
    return {
      triggered: true,
      reason: "mention"
    };
  }

  if (options.text && containsTriggerName(options.text, options.triggerNames)) {
    return {
      triggered: true,
      reason: "trigger_name"
    };
  }

  return {
    triggered: false,
    reason: null
  };
}
