/**
 * Shared fixture for the {@link CachedGitCloneService} unit suites: the
 * mirror-cache fixture (real local bare remote, seed clone, cache dir) plus a
 * workspace path and a recording stand-in for the plain clone service.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../../../../src/runtime/runtime-service/application/git-clone-service";
import { CachedGitCloneService } from "../../../../src/runtime/runtime-service/infra/cached-git-clone-service";
import type { GitRunner } from "../../../../src/runtime/runtime-service/infra/run-git";
import { GitCliCloneService } from "../../../../src/runtime/runtime-service/infra/git-cli-clone-service";
import { setupFixture } from "./git-mirror-cache-fixtures";

export { createLogger } from "./git-mirror-cache-fixtures";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stands in for the plain clone fallback. Records every call and the state of
 * the workspace path at call time (`null` when it does not exist), so tests
 * can assert the fallback received a clean path.
 */
export class RecordingCloneService implements GitCloneService {
  readonly calls: CloneRepositoryInput[] = [];
  readonly workspaceEntriesAtCall: (string[] | null)[] = [];

  async cloneRepository(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    this.calls.push(input);
    this.workspaceEntriesAtCall.push(
      (await pathExists(input.workspacePath))
        ? await readdir(input.workspacePath)
        : null,
    );
    return { resolvedBranch: "fallback-branch" };
  }
}

export async function setupCachedCloneFixture(
  options: { runGit?: GitRunner } = {},
) {
  const fx = await setupFixture();
  const workspacePath = path.join(fx.root, "workspace");
  const fallback = new RecordingCloneService();

  return {
    ...fx,
    workspacePath,
    fallback,
    service: new CachedGitCloneService({
      cache: fx.cache,
      fallback,
      ...options,
    }),
    serviceWithPlainFallback: new CachedGitCloneService({
      cache: fx.cache,
      fallback: new GitCliCloneService(),
      ...options,
    }),
  };
}
