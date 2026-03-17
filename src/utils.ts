export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomIntInclusive(min: number, max: number): number {
  if (max < min) {
    throw new Error("max must be >= min");
  }

  return min + Math.floor(Math.random() * (max - min + 1));
}

export function chunkText(text: string, maxLength: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.length <= maxLength) {
    return [trimmed];
  }

  const parts: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxLength) {
    const boundary = remaining.slice(0, maxLength).lastIndexOf(" ");
    const splitAt = boundary > Math.floor(maxLength * 0.6) ? boundary : maxLength;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

export function tryParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
