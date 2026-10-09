import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_CONFIG_RELATIVE_PATH } from "@boboddy/sdk/defaults";
import { stripGitUrlCredentials } from "@boboddy/sdk/git-url";
import type { BaseReporter } from "./reporter-types";

/**
 * The first step of `boboddy init` (#140).
 *
 * `init` used to check for `.git` only in the exact working directory, so
 * running it from a subdirectory of a real repo — or from inside a
 * submodule — failed with no indication of what was checked. Resolution now
 * walks up to the real repo root (see `resolveGitRepository` in
 * `@boboddy/worker`), and this step prints what it found — the resolved
 * repo path and `origin` remote URL — before any project-matching or auth
 * logic runs, so a subdirectory walk is never silent to the user.
 *
 * The resolution itself sits behind {@link InitRepositoryResolutionPorts} so
 * both the success and failure paths are unit-testable without a repository
 * on disk.
 */

export interface ResolvedRepository {
  repoRoot: string;
  remoteUrl: string;
}

export interface InitRepositoryResolutionPorts {
  /** Walk up to the real repo root and resolve its `origin` remote URL. */
  resolveGitRepository(): Promise<ResolvedRepository>;
}

/** Spinner copy while the walk-up runs. */
export const REPOSITORY_TASK_LABEL = "Resolving repository…";

/** Resolved task copy: the repo root that was found. */
export function repositoryResolvedLabel(repoRoot: string): string {
  return `Repository: ${repoRoot}`;
}

/**
 * Plain info line for the `origin` remote, printed alongside the task. Any
 * credential embedded in the remote is stripped so it never reaches the
 * terminal or a pasted log.
 */
export function remoteResolvedMessage(remoteUrl: string): string {
  return `Remote: ${stripGitUrlCredentials(remoteUrl)}`;
}

/**
 * Resolve the real git repository and report what was found. Only a failed
 * *resolution* throws — e.g. running outside any git repository, or a repo
 * with no `origin` remote — and it still fails clearly, via the task and the
 * rethrown error `withReporter` surfaces on stderr.
 */
export async function reportResolvedRepository(input: {
  reporter: BaseReporter;
  ports: InitRepositoryResolutionPorts;
}): Promise<ResolvedRepository> {
  const { reporter, ports } = input;

  const task = reporter.startTask(REPOSITORY_TASK_LABEL);
  let resolved: ResolvedRepository;
  try {
    resolved = await ports.resolveGitRepository();
  } catch (error) {
    task.fail("Could not resolve repository");
    throw error;
  }

  task.succeed(repositoryResolvedLabel(resolved.repoRoot));
  reporter.info(remoteResolvedMessage(resolved.remoteUrl));
  return resolved;
}

export function strayProjectConfigMessage(
  cwd: string,
  repoRoot: string,
): string {
  return (
    `Found a stray .boboddy/ in ${cwd} from an earlier run; the project ` +
    `config now lives at ${join(repoRoot, ".boboddy")}/. You can delete the stray one.`
  );
}

/**
 * Earlier versions of `init` wrote `.boboddy/` into whatever subdirectory
 * they ran from. Point out a leftover one instead of migrating it: the user
 * may have edited it, and the root config is now the one that counts.
 */
export function warnAboutStrayProjectConfig(input: {
  cwd: string;
  repoRoot: string;
  reporter: BaseReporter;
}): void {
  const { cwd, repoRoot, reporter } = input;
  if (resolve(cwd) === resolve(repoRoot)) {
    return;
  }
  if (existsSync(join(cwd, PROJECT_CONFIG_RELATIVE_PATH))) {
    reporter.warn(strayProjectConfigMessage(cwd, repoRoot));
  }
}
