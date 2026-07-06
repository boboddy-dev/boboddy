import { describe, expect, test } from "bun:test";
import { CompositeArtifactStore } from "../../../../src/artifacts/artifact-store/infra/composite-artifact-store";
import type {
  ArtifactStore,
  SaveArtifactInput,
  SaveArtifactResult,
} from "../../../../src/artifacts/artifact-store/domain/artifact-store";

class RecordingStore implements ArtifactStore {
  readonly calls: SaveArtifactInput[] = [];

  constructor(private readonly result: SaveArtifactResult) {}

  saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> {
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

class FailingStore implements ArtifactStore {
  saveArtifact(): Promise<SaveArtifactResult> {
    return Promise.reject(new Error("store failed"));
  }
}

const input: SaveArtifactInput = {
  stepExecutionId: "step-1",
  sourcePath: "/tmp/report.txt",
  relativeStorePath: "report.txt",
  kind: "generic",
};

describe("CompositeArtifactStore", () => {
  test("throws when constructed with no stores", () => {
    expect(() => new CompositeArtifactStore([])).toThrow(
      /at least one store/,
    );
  });

  test("writes to every store", async () => {
    const local = new RecordingStore({ storeRef: "/local/report.txt", sizeBytes: 10 });
    const s3 = new RecordingStore({ storeRef: "s3://b/report.txt", sizeBytes: 10 });
    const composite = new CompositeArtifactStore([local, s3]);

    await composite.saveArtifact(input);

    expect(local.calls).toEqual([input]);
    expect(s3.calls).toEqual([input]);
  });

  test("returns the first store's result as the canonical result", async () => {
    const local = new RecordingStore({ storeRef: "/local/report.txt", sizeBytes: 10 });
    const s3 = new RecordingStore({ storeRef: "s3://b/report.txt", sizeBytes: 99 });
    const composite = new CompositeArtifactStore([local, s3]);

    const result = await composite.saveArtifact(input);

    expect(result).toEqual({ storeRef: "/local/report.txt", sizeBytes: 10 });
  });

  test("rejects when any store fails", async () => {
    const local = new RecordingStore({ storeRef: "/local/report.txt", sizeBytes: 10 });
    const composite = new CompositeArtifactStore([local, new FailingStore()]);

    let caught: unknown;
    try {
      await composite.saveArtifact(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("store failed");
  });
});
