import type { ContentType } from "./domain.js";

export function formatMessageContent(input: {
  contentType: ContentType;
  text: string | null;
  imageDescription: string | null;
}): string {
  const parts: string[] = [];
  const normalizedText = input.text?.trim();
  const normalizedImageDescription = input.imageDescription?.trim();

  if (normalizedText) {
    parts.push(normalizedText);
  }

  if (normalizedImageDescription) {
    parts.push(`[image] ${normalizedImageDescription}`);
  } else if (input.contentType === "image") {
    parts.push("[image attached; description unavailable]");
  }

  return parts.join(" ").trim();
}
