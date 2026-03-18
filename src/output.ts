function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingConfiguredPrefix(text: string, messagePrefix: string): string {
  const normalizedPrefix = messagePrefix.trim();
  if (!normalizedPrefix) {
    return text;
  }

  return text.replace(new RegExp(`^(?:${escapeRegExp(normalizedPrefix)}\\s*)+`), "");
}

function stripLeadingSelfLabel(text: string, botId: string): string {
  const normalizedBotId = botId.trim();
  if (!normalizedBotId) {
    return text;
  }

  return text.replace(new RegExp(`^${escapeRegExp(normalizedBotId)}\\s*(?:[:|>]|[-–—]{1,2})\\s*`, "i"), "");
}

export function sanitizeGeneratedBubble(text: string, input: { botId: string; messagePrefix: string }): string {
  let result = text.trim();
  if (!result) {
    return "";
  }

  for (let index = 0; index < 4; index += 1) {
    const stripped = stripLeadingConfiguredPrefix(
      stripLeadingSelfLabel(stripLeadingConfiguredPrefix(result, input.messagePrefix), input.botId),
      input.messagePrefix
    ).trim();

    if (stripped === result) {
      break;
    }

    result = stripped;
    if (!result) {
      return "";
    }
  }

  return result;
}
