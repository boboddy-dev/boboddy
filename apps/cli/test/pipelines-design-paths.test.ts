import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PIPELINE_BUILDER_DIR, writeProjectConfig } from "@boboddy/worker";
import { buildDesignPreflightPorts } from "../src/commands/pipelines-design";
import { resolveDesignPaths } from "../src/lib/design-session";
import { createCliLogger } from "../src/lib/logger";
import { createReporterRecorder as createRecorder } from "./utils";

/**
 * `pipelines design` run from a nested directory of a repo must read the
 * project config from, and scaffold the builder into, the repository root —
 * not the subdirectory it was started in.
 */

describe("pipelines design paths", () => {
  let repoRoot: string;
  let nested: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(resolve(tmpdir(), "boboddy-design-nested-"));
    execFileSync("git", ["-C", repoRoot, "init", "-b", "main"]);
    nested = join(repoRoot, "packages", "app");
    mkdirSync(nested, { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("resolves the repo root from a nested cwd", async () => {
    expect(
      await resolveDesignPaths({ repoRoot: undefined, cwd: nested }),
    ).toEqual({
      repoRoot,
      projectRoot: repoRoot,
      builderDir: join(repoRoot, PIPELINE_BUILDER_DIR),
    });
  });

  test("an explicit repoRoot (from init) wins over the cwd", async () => {
    const paths = await resolveDesignPaths({ repoRoot, cwd: "/elsewhere" });
    expect(paths.builderDir).toBe(join(repoRoot, PIPELINE_BUILDER_DIR));
  });

  test("falls back to the cwd, with no repo root, outside any repository", async () => {
    const outside = mkdtempSync(resolve(tmpdir(), "boboddy-design-outside-"));
    try {
      expect(
        await resolveDesignPaths({ repoRoot: undefined, cwd: outside }),
      ).toEqual({
        repoRoot: null,
        projectRoot: outside,
        builderDir: join(outside, PIPELINE_BUILDER_DIR),
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the preflight ports read the root config and scaffold at the root", async () => {
    await writeProjectConfig("root-project", repoRoot);
    const paths = await resolveDesignPaths({
      repoRoot: undefined,
      cwd: nested,
    });
    const { reporter } = createRecorder();
    const ports = buildDesignPreflightPorts(paths, {
      reporter,
      logger: createCliLogger("test"),
      logFilePath: "",
    });

    expect(await ports.readConfiguredProjectId()).toBe("root-project");
    expect(ports.builderDirExists()).toBe(false);

    ports.scaffoldBuilderDir();

    expect(ports.builderDirExists()).toBe(true);
    expect(existsSync(join(repoRoot, PIPELINE_BUILDER_DIR))).toBe(true);
    expect(existsSync(join(nested, ".boboddy"))).toBe(false);
  });
});
