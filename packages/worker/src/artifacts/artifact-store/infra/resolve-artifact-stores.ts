import os from "node:os";
import path from "node:path";
import { ConfigurationError } from "../../../lib/errors";
import type { RemoteArtifactUploader } from "../../../work/step-execution/contracts/process-project-work-types";
import type { ArtifactStore } from "../domain/artifact-store";
import { CompositeArtifactStore } from "./composite-artifact-store";
import { LocalArtifactStore } from "./local-artifact-store";
import { RemoteArtifactStore } from "./remote-artifact-store";

type Env = Record<string, string | undefined>;

export type ResolveArtifactStoresOptions = {
  /**
   * Default base directory for the local store when
   * `BOBODDY_ARTIFACT_LOCAL_DIR` is not set. Defaults to `~/.boboddy/artifacts`.
   */
  defaultLocalDir?: string | undefined;
  /**
   * Dependency used to build the `remote` store. The worker API client
   * satisfies this. Required whenever `remote` is selected (which it is by
   * default) — omitting it while `remote` is active is a configuration error.
   */
  remoteUploader?: RemoteArtifactUploader | undefined;
};

type StoreKind = "local" | "remote";

/**
 * Builds the artifact store to use for a `boboddy work` run from environment
 * configuration.
 *
 * Selection rules:
 *   - `BOBODDY_ARTIFACT_STORES` (comma list of `local`/`remote`) selects stores
 *     explicitly. When set, every listed store is required.
 *   - When unset, both `local` and `remote` are enabled by default. This mirrors
 *     production: artifacts land locally for inspection and are uploaded to the
 *     app-owned object store via presigned URLs from the API.
 *
 * The `remote` store uploads through the API (see {@link RemoteArtifactStore})
 * and therefore needs an uploader dependency; selecting it without providing
 * `options.remoteUploader` throws.
 *
 * The returned store always wraps the selected stores in a
 * {@link CompositeArtifactStore}, with the local store first so its `storeRef`
 * is the canonical result.
 */
export function resolveArtifactStores(
  env: Env,
  options?: ResolveArtifactStoresOptions,
): ArtifactStore {
  const selection = resolveSelection(env);

  const stores: ArtifactStore[] = [];
  if (selection.includes("local")) {
    stores.push(buildLocalStore(env, options));
  }
  if (selection.includes("remote")) {
    stores.push(buildRemoteStore(options));
  }

  if (stores.length === 0) {
    throw new ConfigurationError(
      "No artifact stores are enabled. Set BOBODDY_ARTIFACT_STORES to include 'local' and/or 'remote'.",
      "ARTIFACT_STORES_EMPTY",
    );
  }

  return new CompositeArtifactStore(stores);
}

function resolveSelection(env: Env): StoreKind[] {
  const raw = env["BOBODDY_ARTIFACT_STORES"]?.trim();

  if (raw) {
    const requested = raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

    const selection: StoreKind[] = [];
    for (const entry of requested) {
      if (entry === "local" || entry === "remote") {
        if (!selection.includes(entry)) {
          selection.push(entry);
        }
        continue;
      }
      throw new ConfigurationError(
        `Unknown artifact store '${entry}' in BOBODDY_ARTIFACT_STORES. Valid values are 'local' and 'remote'.`,
        "ARTIFACT_STORE_UNKNOWN",
      );
    }
    return selection;
  }

  // Default: both local and remote are enabled.
  return ["local", "remote"];
}

function buildLocalStore(
  env: Env,
  options?: ResolveArtifactStoresOptions,
): LocalArtifactStore {
  const configuredDir = env["BOBODDY_ARTIFACT_LOCAL_DIR"]?.trim();
  const baseDir =
    configuredDir && configuredDir.length > 0
      ? configuredDir
      : (options?.defaultLocalDir ??
        path.join(os.homedir(), ".boboddy", "artifacts"));
  return new LocalArtifactStore(baseDir);
}

function buildRemoteStore(
  options?: ResolveArtifactStoresOptions,
): RemoteArtifactStore {
  if (!options?.remoteUploader) {
    throw new ConfigurationError(
      "Remote artifact store requested but no remote uploader was provided.",
      "REMOTE_UPLOADER_MISSING",
    );
  }
  return new RemoteArtifactStore(options.remoteUploader);
}
