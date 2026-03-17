import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function extensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}

export function persistInboundImage(mediaDir: string, externalId: string, mimeType: string, buffer: Buffer): string {
  mkdirSync(mediaDir, { recursive: true });
  const safeId = externalId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(mediaDir, `${safeId}${extensionFromMimeType(mimeType)}`);
  writeFileSync(filePath, buffer);
  return filePath;
}
