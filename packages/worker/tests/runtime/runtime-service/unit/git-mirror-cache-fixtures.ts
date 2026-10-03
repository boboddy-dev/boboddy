/**
 * Shared fixture for the {@link GitCliMirrorCache} unit suites: a real local
 * bare "remote", a seed clone to commit from, and a cache dir.
 */
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mirrorKey } from "../../../../src/runtime/runtime-service/domain/git-mirror-key";
import {
  GitCliMirrorCache,
  type GitCliMirrorCacheOptions,
} from "../../../../src/runtime/runtime-service/infra/git-cli-mirror-cache";
import { git, writeRepoFile } from "./git-test-fixtures";

export type LogLine = {
  scope: string;
  message: string;
  details?: Record<string, unknown> | undefined;
};

export function createLogger() {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: {
      log(
        scope: string,
        message: string,
        details?: Record<string, unknown>,
      ): void {
        lines.push({ scope, message, details });
      },
    },
  };
}

export async function setupFixture(
  cacheOptions: Partial<GitCliMirrorCacheOptions> = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-mirror-cache-"));
  const remote = path.join(root, "remote.git");
  const cacheDir = path.join(root, "cache");

  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare", "-b", "main"]);

  const seed = path.join(root, "seed");
  await git(root, ["clone", remote, seed]);
  await git(seed, ["config", "user.email", "seed@boboddy.dev"]);
  await git(seed, ["config", "user.name", "Seed"]);
  await writeRepoFile(seed, "README.md", "hello\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "--no-gpg-sign", "-m", "init"]);
  await git(seed, ["push", "origin", "main"]);

  async function commit(message: string): Promise<string> {
    await writeRepoFile(seed, `${message}.txt`, `${message}\n`);
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--no-gpg-sign", "-m", message]);
    return git(seed, ["rev-parse", "HEAD"]);
  }

  const key = mirrorKey(remote);
  if (key === null) {
    throw new Error(`fixture remote ${remote} has no mirror key`);
  }

  return {
    root,
    remote,
    seed,
    cacheDir,
    commit,
    cache: new GitCliMirrorCache({
      cacheDir,
      lockPollIntervalMs: 10,
      ...cacheOptions,
    }),
    mirrorPath: path.join(cacheDir, `${key}.git`),
    lockPath: path.join(cacheDir, `${key}.lock`),
  };
}
