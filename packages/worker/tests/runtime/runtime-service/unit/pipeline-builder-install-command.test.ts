/**
 * The managed install command, per identifier and lockfile. Regressing a cell
 * here silently changes which dependency versions a code step runs on, so every
 * cell is spelled out. Never `ci` / `--frozen-lockfile`.
 */
import { describe, expect, test } from "bun:test";
import { MANAGED_RUNTIMES } from "../../../../src/runtime/runtime-service/domain/managed-runtimes";
import { buildPipelineBuilderInstallCommand } from "../../../../src/runtime/runtime-service/domain/pipeline-builder-install-command";
import type { PipelineBuilderLockfileName } from "../../../../src/runtime/runtime-service/domain/pipeline-builder-lockfiles";

const BUN_CD = "cd .boboddy/pipeline-builder";
const NPM = "npm install --omit=dev --no-audit --no-fund";

function command(
  id: keyof typeof MANAGED_RUNTIMES,
  ...present: PipelineBuilderLockfileName[]
): string {
  return buildPipelineBuilderInstallCommand({
    present: new Set(present),
    definition: MANAGED_RUNTIMES[id],
  });
}

describe("bun1", () => {
  test.each<[string, PipelineBuilderLockfileName[], string]>([
    [
      "no lockfile",
      [],
      `${BUN_CD} && bun install --production && rm -f bun.lock`,
    ],
    [
      "package-lock.json",
      ["package-lock.json"],
      `${BUN_CD} && bun install --production && rm -f bun.lock`,
    ],
    [
      "yarn.lock",
      ["yarn.lock"],
      `${BUN_CD} && bun install --production && rm -f bun.lock`,
    ],
    [
      "pnpm-lock.yaml",
      ["pnpm-lock.yaml"],
      `${BUN_CD} && bun install --production && rm -f bun.lock`,
    ],
    ["bun.lock", ["bun.lock"], `${BUN_CD} && bun install --production`],
    [
      "bun.lockb",
      ["bun.lockb"],
      `${BUN_CD} && bun install --production && rm -f bun.lock`,
    ],
  ])("%s", (_name, present, expected) => {
    expect(command("bun1", ...present)).toBe(expected);
  });
});

describe("node24", () => {
  test.each<[string, PipelineBuilderLockfileName[], string]>([
    ["no lockfile", [], `${BUN_CD} && ${NPM} && rm -f package-lock.json`],
    ["package-lock.json", ["package-lock.json"], `${BUN_CD} && ${NPM}`],
    [
      "yarn.lock",
      ["yarn.lock"],
      `${BUN_CD} && ${NPM} && rm -f package-lock.json`,
    ],
    [
      "pnpm-lock.yaml goes through corepack because npm would ignore it",
      ["pnpm-lock.yaml"],
      `${BUN_CD} && corepack pnpm install --prod`,
    ],
    [
      "bun.lock falls back to npm and says the lockfile is not used",
      ["bun.lock"],
      `${BUN_CD} && echo 'boboddy: npm does not read bun.lock; installing without it (use the bun1 managed runtime to honor it)' 1>&2 && ${NPM} && rm -f package-lock.json`,
    ],
    [
      "bun.lockb falls back to npm and says the lockfile is not used",
      ["bun.lockb"],
      `${BUN_CD} && echo 'boboddy: npm does not read bun.lockb; installing without it (use the bun1 managed runtime to honor it)' 1>&2 && ${NPM} && rm -f package-lock.json`,
    ],
  ])("%s", (_name, present, expected) => {
    expect(command("node24", ...present)).toBe(expected);
  });

  test("the first lockfile in table order wins when several are present", () => {
    expect(command("node24", "package-lock.json", "pnpm-lock.yaml")).toBe(
      `${BUN_CD} && corepack pnpm install --prod`,
    );
  });

  test("a deno manifest alone is not a node lockfile: plain install", () => {
    expect(command("node24", "deno.json")).toBe(
      `${BUN_CD} && ${NPM} && rm -f package-lock.json`,
    );
  });
});

describe("every command", () => {
  const presences: PipelineBuilderLockfileName[][] = [
    [],
    ["bun.lock"],
    ["bun.lockb"],
    ["pnpm-lock.yaml"],
    ["yarn.lock"],
    ["package-lock.json"],
  ];

  test.each(Object.keys(MANAGED_RUNTIMES) as (keyof typeof MANAGED_RUNTIMES)[])(
    "%s never uses ci or a frozen lockfile and contains no // sequence",
    (id) => {
      for (const present of presences) {
        const built = command(id, ...present);
        expect(built).not.toMatch(/\bci\b/);
        expect(built).not.toContain("--frozen-lockfile");
        expect(built).not.toContain("//");
      }
    },
  );

  test("never removes a lockfile the author already had", () => {
    for (const present of presences) {
      for (const id of ["bun1", "node24"] as const) {
        const built = command(id, ...present);
        for (const name of present) {
          expect(built).not.toMatch(new RegExp(`rm -f[^&]*\\b${name}\\b`));
        }
      }
    }
  });
});
