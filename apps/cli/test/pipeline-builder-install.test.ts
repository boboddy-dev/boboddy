import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveBuilderInstaller } from "../src/lib/pipeline-builder-install";

/**
 * Picking the installer for `.boboddy/pipeline-builder`. The rule that matters:
 * an existing lockfile always wins, so a design session never quietly switches
 * a project's package manager and leaves two lockfiles behind.
 */

const DIR = "/repo/.boboddy/pipeline-builder";

function withLockfile(name: string) {
  return (path: string) => path === join(DIR, name);
}

describe("resolveBuilderInstaller", () => {
  test.each([
    ["bun.lock", "bun install"],
    ["bun.lockb", "bun install"],
    ["pnpm-lock.yaml", "pnpm install"],
    ["yarn.lock", "yarn install"],
    ["package-lock.json", "npm install"],
    ["deno.lock", "deno install"],
  ])("%s selects `%s`", (lockfile, label) => {
    const installer = resolveBuilderInstaller(DIR, {
      fileExists: withLockfile(lockfile),
      // Nothing on PATH: the lockfile must be enough to decide.
      hasCommand: () => false,
    });

    expect(installer?.label).toBe(label);
  });

  test("an existing lockfile beats whatever is on PATH", () => {
    const installer = resolveBuilderInstaller(DIR, {
      fileExists: withLockfile("package-lock.json"),
      hasCommand: () => true,
    });

    expect(installer?.label).toBe("npm install");
  });

  test("a fresh directory prefers bun when it is available", () => {
    const installer = resolveBuilderInstaller(DIR, {
      fileExists: () => false,
      hasCommand: () => true,
    });

    expect(installer?.command).toBe("bun");
  });

  test("a fresh directory falls back to npm without bun", () => {
    const installer = resolveBuilderInstaller(DIR, {
      fileExists: () => false,
      hasCommand: (command) => command === "npm",
    });

    expect(installer?.command).toBe("npm");
  });

  test("returns null when no package manager exists at all", () => {
    expect(
      resolveBuilderInstaller(DIR, {
        fileExists: () => false,
        hasCommand: () => false,
      }),
    ).toBeNull();
  });
});
