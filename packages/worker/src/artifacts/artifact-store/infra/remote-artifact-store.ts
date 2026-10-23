import { readFile } from "node:fs/promises";
import type { RemoteArtifactUploader } from "../../../work/task/contracts/process-project-work-types";
import { detectArtifactContentType } from "../domain/artifact-content-type";
import type {
  ArtifactStore,
  SaveArtifactInput,
  SaveArtifactResult,
} from "../domain/artifact-store";

/**
 * Persists step artifacts to the app-owned object store via presigned PUT URLs
 * obtained from the API. The flow is:
 *
 *   1. `createArtifactUploadUrl` — ask the API for a presigned URL + object key.
 *   2. `PUT` the raw bytes to that URL.
 *   3. `recordArtifact` — tell the API the upload succeeded so it can persist
 *      the artifact row (size, content type, object key).
 *
 * The API authorizes both control-plane calls with the task's
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
        `RemoteArtifactStore requires a claimToken to upload artifact '${input.relativeStorePath}' for task ${input.taskId}.`,
      );
    }
    const claimToken = input.claimToken;

    const bytes = await readFile(input.sourcePath);
    const sizeBytes = bytes.byteLength;
    const contentType = detectArtifactContentType(input.relativeStorePath);

    const { uploadUrl, storeRef, objectKey } =
      await this.uploader.createArtifactUploadUrl({
        taskId: input.taskId,
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
      taskId: input.taskId,
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
