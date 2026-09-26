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

/** A store that only implements `saveArtifact` — proves `prune`'s optional
 * chaining works against a store that never opted into pruning (e.g. the
 * real `RemoteArtifactStore`). */
class NoPruneStore implements ArtifactStore {
  saveArtifact(): Promise<SaveArtifactResult> {
    return Promise.resolve({ storeRef: "no-prune", sizeBytes: 0 });
  }
}

class RecordingPruneStore implements ArtifactStore {
  pruneCalls = 0;

  saveArtifact(): Promise<SaveArtifactResult> {
    return Promise.resolve({ storeRef: "recording-prune", sizeBytes: 0 });
  }

  prune(): Promise<void> {
    this.pruneCalls += 1;
    return Promise.resolve();
  }
}

class FailingPruneStore implements ArtifactStore {
  saveArtifact(): Promise<SaveArtifactResult> {
    return Promise.resolve({ storeRef: "failing-prune", sizeBytes: 0 });
  }

  prune(): Promise<void> {
    return Promise.reject(new Error("prune failed"));
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
    expect(() => new CompositeArtifactStore([])).toThrow(/at least one store/);
  });

  test("writes to every store", async () => {
    const local = new RecordingStore({
      storeRef: "/local/report.txt",
      sizeBytes: 10,
    });
    const s3 = new RecordingStore({
      storeRef: "s3://b/report.txt",
      sizeBytes: 10,
    });
    const composite = new CompositeArtifactStore([local, s3]);

    await composite.saveArtifact(input);

    expect(local.calls).toEqual([input]);
    expect(s3.calls).toEqual([input]);
  });

  test("returns the first store's result as the canonical result", async () => {
    const local = new RecordingStore({
      storeRef: "/local/report.txt",
      sizeBytes: 10,
    });
    const s3 = new RecordingStore({
      storeRef: "s3://b/report.txt",
      sizeBytes: 99,
    });
    const composite = new CompositeArtifactStore([local, s3]);

    const result = await composite.saveArtifact(input);

    expect(result).toEqual({ storeRef: "/local/report.txt", sizeBytes: 10 });
  });

  test("rejects when any store fails", async () => {
    const local = new RecordingStore({
      storeRef: "/local/report.txt",
      sizeBytes: 10,
    });
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

  test("prune() fans out to every store that implements it", async () => {
    const a = new RecordingPruneStore();
    const b = new RecordingPruneStore();
    const composite = new CompositeArtifactStore([a, b]);

    await composite.prune();

    expect(a.pruneCalls).toBe(1);
    expect(b.pruneCalls).toBe(1);
  });

  test("prune() tolerates a store that doesn't implement prune", async () => {
    const withPrune = new RecordingPruneStore();
    const composite = new CompositeArtifactStore([
      withPrune,
      new NoPruneStore(),
    ]);

    await composite.prune();

    expect(withPrune.pruneCalls).toBe(1);
  });

  test("prune() tolerates one store's prune rejecting without failing the others or the overall call", async () => {
    const succeeds = new RecordingPruneStore();
    const composite = new CompositeArtifactStore([
      succeeds,
      new FailingPruneStore(),
    ]);

    // Resolves without throwing, even though FailingPruneStore rejects.
    await composite.prune();

    expect(succeeds.pruneCalls).toBe(1);
  });
});
