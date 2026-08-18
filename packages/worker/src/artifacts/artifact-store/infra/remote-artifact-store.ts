import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RemoteArtifactUploader } from "../../../work/step-execution/contracts/process-project-work-types";
import type {
  ArtifactStore,
  SaveArtifactInput,
  SaveArtifactResult,
} from "../domain/artifact-store";

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
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function detectContentType(relativeStorePath: string): string {
  const ext = path.extname(relativeStorePath).replace(/^\./, "").toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Persists step artifacts to the app-owned object store via presigned PUT URLs
 * obtained from the API. The flow is:
 *
 *   1. `createArtifactUploadUrl` — ask the API for a presigned URL + object key.
 *   2. `PUT` the raw bytes to that URL.
 *   3. `recordArtifact` — tell the API the upload succeeded so it can persist
 *      the artifact row (size, content type, object key).
 *
 * The API authorizes both control-plane calls with the step execution's
 * `claimToken`, which is threaded through {@link SaveArtifactInput.claimToken}
 * (local stores ignore it). Because the store is built once and reused across
 * executions, it cannot close over a single token — it reads the token off each
 * call and throws a clear error if it is missing.
 */
export class RemoteArtifactStore implements ArtifactStore {
  constructor(private readonly uploader: RemoteArtifactUploader) {}

  async saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> {
    if (!input.claimToken) {
      throw new Error(
        `RemoteArtifactStore requires a claimToken to upload artifact '${input.relativeStorePath}' for step execution ${input.stepExecutionId}.`,
      );
    }
    const claimToken = input.claimToken;

    const bytes = await readFile(input.sourcePath);
    const sizeBytes = bytes.byteLength;
    const contentType = detectContentType(input.relativeStorePath);

    const { uploadUrl, storeRef, objectKey } =
      await this.uploader.createArtifactUploadUrl({
        stepExecutionId: input.stepExecutionId,
        claimToken,
        relativeStorePath: input.relativeStorePath,
        contentType,
        sizeBytes,
      });

    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": contentType },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Artifact upload failed (${String(response.status)} ${response.statusText}) for '${input.relativeStorePath}': ${text}`,
      );
    }

    await this.uploader.recordArtifact({
      stepExecutionId: input.stepExecutionId,
      claimToken,
      objectKey,
      relativeStorePath: input.relativeStorePath,
      sizeBytes,
      contentType,
      kind: input.kind,
    });

    return { storeRef, sizeBytes };
  }
}
