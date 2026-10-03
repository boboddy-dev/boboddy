/**
 * Unit tests for {@link createGitCloneService}: the shared factory that picks
 * the plain or the mirror-backed clone service from the env map.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { noopLogger } from "@boboddy/observability/logging/host";
import { ConfigurationError } from "../../../../src/lib/errors";
import { CachedGitCloneService } from "../../../../src/runtime/runtime-service/infra/cached-git-clone-service";
import { createGitCloneService } from "../../../../src/runtime/runtime-service/infra/create-git-clone-service";
import { GitCliCloneService } from "../../../../src/runtime/runtime-service/infra/git-cli-clone-service";
import {
  pathExists,
  setupCachedCloneFixture,
} from "./cached-git-clone-fixtures";
import { git } from "./git-test-fixtures";

describe("createGitCloneService", () => {
  test("BOBODDY_GIT_CACHE=off returns the plain service and no cache dir", () => {
    const result = createGitCloneService(
      { BOBODDY_GIT_CACHE: "off", HOME: "/home/tester" },
      noopLogger,
    );

    expect(result.gitCloneService).toBeInstanceOf(GitCliCloneService);
    expect(result.cacheDir).toBeNull();
  });

  test("on by default with the cache dir under HOME", () => {
    const result = createGitCloneService({ HOME: "/home/tester" }, noopLogger);

    expect(result.gitCloneService).toBeInstanceOf(CachedGitCloneService);
    expect(result.cacheDir).toBe(
      path.join("/home/tester", ".boboddy", "git-cache"),
    );
  });

  test("BOBODDY_GIT_CACHE_DIR is the resolved cache dir", () => {
    const result = createGitCloneService(
      { BOBODDY_GIT_CACHE: "on", BOBODDY_GIT_CACHE_DIR: "/var/cache/git" },
      noopLogger,
    );

    expect(result.gitCloneService).toBeInstanceOf(CachedGitCloneService);
    expect(result.cacheDir).toBe("/var/cache/git");
  });

  test("an unknown BOBODDY_GIT_CACHE value throws", () => {
    expect(() =>
      createGitCloneService({ BOBODDY_GIT_CACHE: "maybe" }, noopLogger),
    ).toThrow(ConfigurationError);
  });

  test("the cached service builds its mirror under the resolved cache dir", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "create-git-clone-"));
    try {
      const fx = await setupCachedCloneFixture();
      try {
        const cacheDir = path.join(root, "cache");
        const { gitCloneService } = createGitCloneService(
          { BOBODDY_GIT_CACHE_DIR: cacheDir },
          noopLogger,
        );

        const result = await gitCloneService.cloneRepository({
          gitUrl: fx.remote,
          workspacePath: path.join(root, "workspace"),
        });

        expect(result.resolvedBranch).toBe("main");
        expect(
          await pathExists(path.join(cacheDir, path.basename(fx.mirrorPath))),
        ).toBe(true);
        expect(
          await git(path.join(root, "workspace"), [
            "config",
            "--get",
            "remote.origin.url",
          ]),
        ).toBe(fx.remote);
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
