/**
 * `buildDryRunWorkspaceOrchestrator` builds its clone service through the same
 * shared factory as the real orchestrator, so a dry run exercises the mirror
 * cache (or the plain clone when `BOBODDY_GIT_CACHE=off`) exactly like a real
 * run.
 */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { noopLogger } from "@boboddy/observability/logging/host";
import { ConfigurationError } from "../../../../src/lib/errors";
import { buildDryRunWorkspaceOrchestrator } from "../../../../src/work/step-execution/application/run-work-dry-run-orchestrators";
import { DirectProviderAccessResolver } from "../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";
import { SafeProviderAccessResolver } from "../../../../src/work/step-execution/infra/provider-access/safe-provider-access-resolver";
import {
  pathExists,
  setupCachedCloneFixture,
} from "../../../runtime/runtime-service/unit/cached-git-clone-fixtures";
import { buildLaunchInput } from "./helpers/orchestrator-launch-fakes";

describe("buildDryRunWorkspaceOrchestrator git cache wiring", () => {
  let fixtureRoot: string | null = null;

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = null;
    }
  });

  function safeResolver() {
    return new SafeProviderAccessResolver(
      new DirectProviderAccessResolver({ logger: noopLogger }),
    );
  }

  async function launchAgainstFixture(localEnvVars: Record<string, string>) {
    const fx = await setupCachedCloneFixture();
    fixtureRoot = fx.root;
    const orchestrator = buildDryRunWorkspaceOrchestrator(
      noopLogger,
      { BOBODDY_GIT_CACHE_DIR: fx.cacheDir, ...localEnvVars },
      safeResolver(),
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

  test("an unknown BOBODDY_GIT_CACHE value fails construction", () => {
    expect(() =>
      buildDryRunWorkspaceOrchestrator(
        noopLogger,
        { BOBODDY_GIT_CACHE: "maybe" },
        safeResolver(),
      ),
    ).toThrow(ConfigurationError);
  });
});
