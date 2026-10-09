import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveTelemetryDefines } from "../script/telemetry-defines";

/**
 * Proves the PostHog key `script/build.ts` bakes in with `--define` survives
 * `bun build --compile`: the define is a string replacement inside a compiled
 * binary, so only running the artifact shows it's there. Builds the real CLI
 * entrypoint for the host platform with the same `bun build --compile` flags
 * and the same {@link resolveTelemetryDefines} as `script/build.ts`, then asks
 * the binary itself via `telemetry status --json`.
 *
 * Isolation: the shell may carry real `POSTHOG_*` values, and both Bun and the
 * CLI auto-load `.env` from the working directory. The build env is an
 * explicit allow-list, and the binary runs in a scratch cwd with a scratch
 * `HOME`, so no developer key or persisted opt-out can leak in. The test key
 * is a fake.
 *
 * Plain `test()`: each case compiles a real binary.
 */

const projectRoot = resolve(import.meta.dir, "..");
const entrypoint = resolve(projectRoot, "src/index.ts");
const TEST_KEY = "phc_test_compiled";

function isolatedEnv(
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = { HOME: home, ...extra };
  for (const name of ["PATH", "TMPDIR"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/** Mirrors `apps/cli/script/build.ts`'s `buildTarget()` macOS re-sign. */
async function codesignIfDarwin(outfile: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const strip = Bun.spawn(["codesign", "--remove-signature", outfile], {
    stdout: "ignore",
    stderr: "inherit",
  });
  await strip.exited;
  const sign = Bun.spawn(["codesign", "--sign", "-", "--force", outfile], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await sign.exited) !== 0) {
    throw new Error(`codesign failed for ${outfile}`);
  }
}

async function compileCli(
  outfile: string,
  buildEnv: Record<string, string>,
  scratchHome: string,
): Promise<void> {
  const defines = resolveTelemetryDefines(buildEnv, () => undefined);
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      entrypoint,
      "--compile",
      `--outfile=${outfile}`,
      "--external=node-gyp",
      ...defines,
    ],
    {
      cwd: projectRoot,
      env: isolatedEnv(scratchHome),
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(build.stderr).text();
  if ((await build.exited) !== 0) {
    throw new Error(`Compile failed:\n${stderr}`);
  }
  await codesignIfDarwin(outfile);
}

async function telemetryStatusJson(
  binary: string,
  scratchHome: string,
  scratchCwd: string,
): Promise<{ stdout: string; parsed: unknown }> {
  const proc = Bun.spawn([binary, "telemetry", "status", "--json"], {
    cwd: scratchCwd,
    env: isolatedEnv(scratchHome),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`telemetry status exited ${String(exitCode)}:\n${stderr}`);
  }
  return { stdout, parsed: JSON.parse(stdout) };
}

async function withScratch(
  fn: (dirs: { outDir: string; home: string; cwd: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "boboddy-telemetry-key-"));
  const dirs = {
    outDir: root,
    home: mkdtempSync(join(root, "home-")),
    cwd: mkdtempSync(join(root, "cwd-")),
  };
  try {
    await fn(dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("compiled CLI binary — baked telemetry key", () => {
  test(
    "a binary built with POSTHOG_CLI_KEY reports keySource: baked",
    async () => {
      await withScratch(async ({ outDir, home, cwd }) => {
        const binary = join(outDir, "boboddy-baked");
        await compileCli(binary, { POSTHOG_CLI_KEY: TEST_KEY }, home);

        const { stdout, parsed } = await telemetryStatusJson(binary, home, cwd);
        expect(parsed).toMatchObject({ enabled: true, keySource: "baked" });
        expect(stdout).not.toContain(TEST_KEY);
      });
    },
    120_000,
  );

  test(
    "a binary built without POSTHOG_CLI_KEY reports keySource: none",
    async () => {
      await withScratch(async ({ outDir, home, cwd }) => {
        const binary = join(outDir, "boboddy-keyless");
        await compileCli(binary, {}, home);

        const { parsed } = await telemetryStatusJson(binary, home, cwd);
        expect(parsed).toMatchObject({ enabled: true, keySource: "none" });
      });
    },
    120_000,
  );
});
