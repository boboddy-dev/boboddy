import type { ArtifactKind } from "@boboddy/sdk/contracts/artifacts";

export type SaveArtifactInput = {
  stepExecutionId: string;
  sourcePath: string;
  relativeStorePath: string;
  /**
   * Classification of the artifact (e.g. Playwright trace vs. generic file),
   * computed at collection time from the store-relative path. Local stores
   * ignore it; the remote store forwards it to the record API.
   */
  kind: ArtifactKind;
  /**
   * Short-lived credential authorizing writes for this step execution. Local
   * stores ignore it; the remote store requires it to obtain a presigned
   * upload URL and to record the artifact against the API.
   */
  claimToken?: string | undefined;
};

export type SaveArtifactResult = {
  storeRef: string;
  sizeBytes: number;
};

export interface ArtifactStore {
  saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult>;
}
