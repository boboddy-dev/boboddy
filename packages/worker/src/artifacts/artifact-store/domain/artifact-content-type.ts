import path from "node:path";
import type { ArtifactKind } from "@boboddy/sdk/contracts/artifacts";

/**
 * Best-effort MIME type lookup keyed by lowercase file extension (without the
 * leading dot). Kept intentionally small — anything unmapped falls back to
 * `application/octet-stream`, which is a safe default for opaque bytes.
 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  csv: "text/csv",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  log: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function detectArtifactContentType(relativeStorePath: string): string {
  const ext = path.extname(relativeStorePath).replace(/^\./, "").toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? DEFAULT_CONTENT_TYPE;
}

/** `video/*` → `video`, `image/*` → `image`, anything else → `generic`. */
export function artifactKindFromContentType(contentType: string): ArtifactKind {
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("image/")) return "image";
  return "generic";
}
