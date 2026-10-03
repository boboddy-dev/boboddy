/**
 * Git mirror cache wiring in the single-container launch orchestrator: the
 * default deps build the clone service from `{...process.env, ...localEnvVars}`
 * through the shared factory, and `launch()` exports the resolved cache dir to
 * the devcontainer CLI's host environment only when the cache is on.
 *
 * Tests that touch `process.env` run serially.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigurationError } from "../../../../src/lib/errors";
import { CachedGitCloneService } from "../../../../src/runtime/runtime-service/infra/cached-git-clone-service";
import { GitCliCloneService } from "../../../../src/runtime/runtime-service/infra/git-cli-clone-service";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import { buildLocalProjectRuntimeDeps } from "../../../../src/work/step-execution/infra/local-project-runtime-environment-deps";
import {
  pathExists,
  setupCachedCloneFixture,
} from "../../../runtime/runtime-service/unit/cached-git-clone-fixtures";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";
import { noopLogger } from "@boboddy/observability/logging/host";

describe("buildLocalProjectRuntimeDeps git cache wiring", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["BOBODDY_GIT_CACHE", "BOBODDY_GIT_CACHE_DIR"]) {
      saved[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  test("uses the cached clone service and the resolved cache dir by default", () => {
    const deps = buildLocalProjectRuntimeDeps(noopLogger, {
      BOBODDY_GIT_CACHE_DIR: "/var/cache/boboddy",
    });

    expect(deps.gitCloneService).toBeInstanceOf(CachedGitCloneService);
    expect(deps.gitCacheDir).toBe("/var/cache/boboddy");
  });

  test("BOBODDY_GIT_CACHE=off in localEnvVars yields the plain service and no cache dir", () => {
    const deps = buildLocalProjectRuntimeDeps(noopLogger, {
      BOBODDY_GIT_CACHE: "off",
    });

    expect(deps.gitCloneService).toBeInstanceOf(GitCliCloneService);
    expect(deps.gitCacheDir).toBeNull();
  });

  test("reads process.env, and localEnvVars override it", () => {
    process.env["BOBODDY_GIT_CACHE_DIR"] = "/from/process";

    expect(buildLocalProjectRuntimeDeps(noopLogger, {}).gitCacheDir).toBe(
      "/from/process",
    );
    expect(
      buildLocalProjectRuntimeDeps(noopLogger, {
        BOBODDY_GIT_CACHE_DIR: "/from/local-env",
      }).gitCacheDir,
    ).toBe("/from/local-env");

    process.env["BOBODDY_GIT_CACHE"] = "off";
    expect(
      buildLocalProjectRuntimeDeps(noopLogger, { BOBODDY_GIT_CACHE: "on" })
        .gitCloneService,
    ).toBeInstanceOf(CachedGitCloneService);
  });

  test("an unknown BOBODDY_GIT_CACHE value throws a ConfigurationError", () => {
    expect(() =>
      buildLocalProjectRuntimeDeps(noopLogger, { BOBODDY_GIT_CACHE: "maybe" }),
    ).toThrow(ConfigurationError);
  });

  test("an unknown BOBODDY_GIT_CACHE value fails orchestrator construction", () => {
    expect(
      () =>
        new DefaultLocalProjectRuntimeEnvironmentOrchestrator(undefined, {
          BOBODDY_GIT_CACHE: "maybe",
        }),
    ).toThrow(ConfigurationError);
  });

  test("overrides replace individual deps while the git wiring stays on the factory", () => {
    const base = buildLocalProjectRuntimeDeps(noopLogger, {
      BOBODDY_GIT_CACHE_DIR: "/var/cache/boboddy",
    });
    const overridden = buildLocalProjectRuntimeDeps(
      noopLogger,
      { BOBODDY_GIT_CACHE_DIR: "/var/cache/boboddy" },
      { submoduleService: base.submoduleService },
    );

    expect(overridden.submoduleService).toBe(base.submoduleService);
    expect(overridden.gitCloneService).toBeInstanceOf(CachedGitCloneService);
    expect(overridden.gitCacheDir).toBe("/var/cache/boboddy");
  });
});

describe("DefaultLocalProjectRuntimeEnvironmentOrchestrator default clone service", () => {
  let fixtureRoot: string | null = null;

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = null;
    }
  });

  async function launchAgainstFixture(localEnvVars: Record<string, string>) {
    const fx = await setupCachedCloneFixture();
    fixtureRoot = fx.root;
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      { BOBODDY_GIT_CACHE_DIR: fx.cacheDir, ...localEnvVars },
    );
    let outcome = "launched";
    try {
      await orchestrator.launch({ ...buildLaunchInput(), gitUrl: fx.remote });
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    expect(outcome).toMatch(/No devcontainer spec found/u);
    return fx;
  }

  test("clones through the mirror cache by default", async () => {
    const fx = await launchAgainstFixture({});

    expect(await pathExists(fx.mirrorPath)).toBe(true);
  });

  test("BOBODDY_GIT_CACHE=off in localEnvVars clones plainly without touching the cache", async () => {
    const fx = await launchAgainstFixture({ BOBODDY_GIT_CACHE: "off" });

    expect(await pathExists(fx.mirrorPath)).toBe(false);
    expect(await pathExists(fx.cacheDir)).toBe(false);
  });
});

describe("DefaultLocalProjectRuntimeEnvironmentOrchestrator.launch hostEnv", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "orchestrator-provider-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  async function launchWith(gitCacheDir: string | null | undefined) {
    const log: CallLog = [];
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
    });
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      gitCacheDir === undefined ? deps : { ...deps, gitCacheDir },
    );
    await orchestrator.launch(buildLaunchInput());
    return deps.devcontainerLauncher.launchInputs;
  }

  test("passes BOBODDY_GIT_CACHE_DIR to the devcontainer CLI when the cache is on", async () => {
    const [input] = await launchWith("/var/cache/boboddy");

    expect(input?.hostEnv).toEqual({
      BOBODDY_GIT_CACHE_DIR: "/var/cache/boboddy",
    });
  });

  test("passes no hostEnv when the cache is off", async () => {
    const [input] = await launchWith(null);

    expect(input?.hostEnv).toBeUndefined();
  });

  test("passes no hostEnv with injected deps that carry no cache dir", async () => {
    const [input] = await launchWith(undefined);

    expect(input?.hostEnv).toBeUndefined();
  });
});
