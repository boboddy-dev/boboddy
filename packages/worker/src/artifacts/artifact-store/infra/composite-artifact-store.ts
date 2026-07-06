import type {
  ArtifactStore,
  SaveArtifactInput,
  SaveArtifactResult,
} from "../domain/artifact-store";

/**
 * Fans a single `saveArtifact` call out to every configured store so a step
 * artifact can be persisted to multiple backends at once (e.g. a local copy and
 * an S3 copy).
 *
 * All stores are written concurrently and every write must succeed — if any
 * store rejects, the whole `saveArtifact` rejects. Callers treat artifact
 * persistence as best-effort at the boundary (see `collectStepArtifacts`), so a
 * hard failure here surfaces a genuine misconfiguration rather than silently
 * dropping a backend.
 *
 * The canonical {@link SaveArtifactResult} returned is the first store's result.
 * Consumers currently ignore the return value; the first store is chosen so the
 * `storeRef` remains stable and predictable (the primary/local store is placed
 * first by the factory).
 */
export class CompositeArtifactStore implements ArtifactStore {
  private readonly stores: readonly ArtifactStore[];

  constructor(stores: readonly ArtifactStore[]) {
    if (stores.length === 0) {
      throw new Error("CompositeArtifactStore requires at least one store");
    }
    this.stores = stores;
  }

  async saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> {
    const results = await Promise.all(
      this.stores.map((store) => store.saveArtifact(input)),
    );
    // Non-null: constructor guarantees at least one store, so at least one result.
    return results[0] as SaveArtifactResult;
  }
}
