import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ConfigurationError } from "../../../lib/errors";

const execFileAsync = promisify(execFile);

/**
 * Walk up from `startDir` looking for a `.git` entry — file or directory, so
 * a submodule's own `.git` file (which points at its real gitdir elsewhere)
 * is found, and returned, before any superproject `.git` further up. This is
 * the same resolution `git rev-parse --show-toplevel` performs, without
 * requiring `git` to be on `PATH` to answer "is this inside a repo at all".
 *
 * Returns the absolute path of the first ancestor (including `startDir`
 * itself) that contains a `.git` entry, or `null` if none exists all the way
 * up to the filesystem root.
 */
export async function findGitRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      await access(path.join(dir, ".git"));
      return dir;
    } catch {
      // Not here — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Shared so callers that gate on repo presence (see `verifyRequirements`) report the same wording. */
export const NOT_IN_GIT_REPOSITORY_MESSAGE =
  "Not inside a git repository. Run 'boboddy init' from inside your project's git repository.";

/**
 * Resolve the `origin` remote URL for the repo rooted at `repoRoot`. The
 * single implementation of this lookup — `localConfigSetup`'s project
 * matching uses it via {@link resolveGitRepository} rather than shelling out
 * to `git remote get-url origin` a second, independent way.
 */
export async function getGitRemoteUrl(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "remote",
      "get-url",
      "origin",
    ]);
    return stdout.trim();
  } catch {
    throw new ConfigurationError(
      "Could not read git remote origin. Make sure this repo has a remote named 'origin'.",
    );
  }
}

export interface ResolvedGitRepository {
  /** The repo root: the first ancestor of `startDir` (inclusive) containing a `.git` entry. */
  repoRoot: string;
  /** The `origin` remote URL, resolved from `repoRoot`. */
  remoteUrl: string;
}

/**
 * Resolve the real git repository — root and `origin` remote URL — by
 * walking up from `startDir` (`process.cwd()` by default) the same way
 * `git rev-parse --show-toplevel` would. Submodule-safe by construction: see
 * {@link findGitRoot}.
 *
 * This is the single source of truth `boboddy init` uses to know what
 * repository it is even operating on, resolved (and reported) before any
 * project-matching or auth logic runs.
 */
export async function resolveGitRepository(
  startDir: string = process.cwd(),
): Promise<ResolvedGitRepository> {
  const repoRoot = await findGitRoot(startDir);
  if (!repoRoot) {
    throw new ConfigurationError(NOT_IN_GIT_REPOSITORY_MESSAGE);
  }

  const remoteUrl = await getGitRemoteUrl(repoRoot);
  return { repoRoot, remoteUrl };
}
