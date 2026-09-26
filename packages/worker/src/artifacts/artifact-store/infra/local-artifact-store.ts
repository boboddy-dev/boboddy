import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRetentionSettings } from "@boboddy/sdk/defaults";
import type {
  ArtifactStore,
  SaveArtifactInput,
  SaveArtifactResult,
} from "../domain/artifact-store";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One `stepExecutionId` directory's worth of accounting used by
 * {@link LocalArtifactStore.prune}: total on-disk size (summed recursively,
 * since a step's artifacts may nest a level or two) and the directory's own
 * (non-recursive) mtime, used as a last-activity proxy — every observed real
 * example writes files directly under the step's directory, so the most
 * recent `copyFile` there bumps the parent directory's mtime without needing
 * a recursive stat walk just for recency. Known limitation: a step that ever
 * wrote *only* into a nested subdirectory, never touching a file at the top
 * level, would have a stale-looking mtime here (see the plan's risk ledger).
 */
type StepDirStats = {
  dirPath: string;
  mtimeMs: number;
  sizeBytes: number;
};

async function sumDirSizeBytes(dirPath: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await sumDirSizeBytes(entryPath);
    } else if (entry.isFile()) {
      try {
        total += (await stat(entryPath)).size;
      } catch {
        // Lost a race with a concurrent writer/deleter — skip it.
      }
    }
  }
  return total;
}

export type LocalArtifactStoreOptions = {
  /**
   * Governs future pruning behavior (see Phase 5). Left `undefined` — and
   * pruning left disabled — whenever `remote` isn't also part of the
   * resolved store selection, since the local copy is then the only copy.
   */
  retention?: ArtifactRetentionSettings;
};

export class LocalArtifactStore implements ArtifactStore {
  private readonly retention: ArtifactRetentionSettings | undefined;

  constructor(
    private readonly baseDir: string,
    options?: LocalArtifactStoreOptions,
  ) {
    this.retention = options?.retention;
  }

  async saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> {
    const dest = path.join(
      this.baseDir,
      input.stepExecutionId,
      input.relativeStorePath,
    );
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(input.sourcePath, dest);
    const { size } = await stat(dest);
    return { storeRef: dest, sizeBytes: size };
  }

  /**
   * Keeps `baseDir` bounded by evicting whole `stepExecutionId` directories,
   * oldest-mtime-first, until both retention bars are cleared (decision 11):
   * total remaining size under `localMaxBytes`, and no surviving directory
   * older than `localMaxAgeDays`. A directory past the age cap is evicted
   * regardless of the size budget — mirrors `pruneLogDir`'s "survives only if
   * it clears every bar" rule, at directory instead of file granularity.
   *
   * No-op when `retention` is `undefined` (local-only mode, decision 8) —
   * `baseDir` isn't even listed in that case. Best-effort throughout
   * (decision 12): a missing `baseDir`, a losing race against a
   * concurrently-writing step, or any other failure is swallowed rather than
   * thrown, since a cleanup failure must never break the step actually being
   * processed.
   */
  async prune({ now = Date.now() }: { now?: number } = {}): Promise<void> {
    if (!this.retention) return;
    const { localMaxBytes, localMaxAgeDays } = this.retention;
    const maxAgeMs = localMaxAgeDays * MS_PER_DAY;

    try {
      let names: string[];
      try {
        names = await readdir(this.baseDir);
      } catch {
        return;
      }

      const dirs = (
        await Promise.all(
          names.map(async (name): Promise<StepDirStats | undefined> => {
            const dirPath = path.join(this.baseDir, name);
            try {
              const info = await stat(dirPath);
              if (!info.isDirectory()) return undefined;
              return {
                dirPath,
                mtimeMs: info.mtimeMs,
                sizeBytes: await sumDirSizeBytes(dirPath),
              };
            } catch {
              return undefined;
            }
          }),
        )
      ).filter((dir): dir is StepDirStats => dir !== undefined);

      dirs.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let remainingBytes = dirs.reduce((sum, dir) => sum + dir.sizeBytes, 0);
      const toDelete: StepDirStats[] = [];
      for (const dir of dirs) {
        const overAge = now - dir.mtimeMs > maxAgeMs;
        const overBudget = remainingBytes > localMaxBytes;
        if (overAge || overBudget) {
          toDelete.push(dir);
          remainingBytes -= dir.sizeBytes;
        }
      }

      await Promise.all(
        toDelete.map((dir) =>
          rm(dir.dirPath, { recursive: true, force: true }).catch(() => {}),
        ),
      );
    } catch {
      // Never let cleanup failures reach the caller.
    }
  }
}
