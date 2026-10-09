import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
 * Delivery: `telemetry status` proves configuration, not delivery. The
 * delivery cases point the baked binary at a local sink via the runtime
 * `POSTHOG_CLI_HOST` override (read by `ensureInitialized` in
 * `src/lib/telemetry.ts`, ahead of any baked host; the baked binary here has
 * no baked host) and assert the event already arrived by the time the process
 * exited — the CLI must await delivery before `process.exit`, so no polling.
 *
 * Isolation: the shell may carry real `POSTHOG_*` values, and both Bun and the
 * CLI auto-load `.env` from the working directory. The build env is an
 * explicit allow-list, and the binary runs in a scratch cwd with a scratch
 * `HOME`, so no developer key or persisted opt-out can leak in. The test key
 * is a fake.
 *
 * Plain `test()`: the cases compile real binaries and share one sink whose
 * recorded requests are reset per run.
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

type SinkBatch = {
  api_key?: string;
  batch?: Array<{ event?: string; properties?: Record<string, unknown> }>;
};

type Sink = {
  url: string;
  requests: SinkBatch[];
  stop: () => Promise<void>;
};

/** A local PostHog stand-in that records every request body it receives. */
function startSink(): Sink {
  const requests: SinkBatch[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const raw = new Uint8Array(await request.arrayBuffer());
      const gzipped =
        request.headers.get("content-encoding") === "gzip" ||
        url.searchParams.get("compression") === "gzip-js";
      const text = new TextDecoder().decode(
        gzipped ? Bun.gunzipSync(raw) : raw,
      );
      requests.push(text ? (JSON.parse(text) as SinkBatch) : {});
      return Response.json({ status: 1 });
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    requests,
    stop: () => server.stop(true),
  };
}

async function runUnknownCommand(
  binary: string,
  scratchHome: string,
  scratchCwd: string,
  extraEnv: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([binary, "definitely-not-a-command"], {
    cwd: scratchCwd,
    env: isolatedEnv(scratchHome, extraEnv),
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
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
  let bakedRoot: string;
  let bakedBinary: string;
  let sink: Sink;

  function scratchRun(): { home: string; cwd: string } {
    return {
      home: mkdtempSync(join(bakedRoot, "home-")),
      cwd: mkdtempSync(join(bakedRoot, "cwd-")),
    };
  }

  beforeAll(async () => {
    sink = startSink();
    bakedRoot = mkdtempSync(join(tmpdir(), "boboddy-telemetry-key-"));
    bakedBinary = join(bakedRoot, "boboddy-baked");
    await compileCli(
      bakedBinary,
      { POSTHOG_CLI_KEY: TEST_KEY },
      mkdtempSync(join(bakedRoot, "build-home-")),
    );
  }, 120_000);

  afterAll(async () => {
    await sink.stop();
    if (bakedRoot) rmSync(bakedRoot, { recursive: true, force: true });
  });

  test("a binary built with POSTHOG_CLI_KEY reports keySource: baked", async () => {
    const { home, cwd } = scratchRun();
    const { stdout, parsed } = await telemetryStatusJson(
      bakedBinary,
      home,
      cwd,
    );
    expect(parsed).toMatchObject({ enabled: true, keySource: "baked" });
    expect(stdout).not.toContain(TEST_KEY);
  });

  test("a baked binary delivers cli_command_failed before exiting", async () => {
    sink.requests.length = 0;
    const { home, cwd } = scratchRun();

    const { exitCode, stderr } = await runUnknownCommand(
      bakedBinary,
      home,
      cwd,
      { POSTHOG_CLI_HOST: sink.url },
    );

    expect(exitCode, stderr).toBe(1);
    const delivered = sink.requests.flatMap((body) =>
      (body.batch ?? []).map((message) => ({
        apiKey: body.api_key,
        event: message.event,
        keySource: message.properties?.["cli_key_source"],
      })),
    );
    expect(delivered).toContainEqual({
      apiKey: TEST_KEY,
      event: "cli_command_failed",
      keySource: "baked",
    });
  });

  test("a binary with BOBODDY_TELEMETRY_DISABLED=1 delivers nothing", async () => {
    sink.requests.length = 0;
    const { home, cwd } = scratchRun();

    const { exitCode, stderr } = await runUnknownCommand(
      bakedBinary,
      home,
      cwd,
      { POSTHOG_CLI_HOST: sink.url, BOBODDY_TELEMETRY_DISABLED: "1" },
    );

    expect(exitCode, stderr).toBe(1);
    expect(sink.requests).toEqual([]);
  });

  test("a binary built without POSTHOG_CLI_KEY reports keySource: none", async () => {
    await withScratch(async ({ outDir, home, cwd }) => {
      const binary = join(outDir, "boboddy-keyless");
      await compileCli(binary, {}, home);

      const { parsed } = await telemetryStatusJson(binary, home, cwd);
      expect(parsed).toMatchObject({ enabled: true, keySource: "none" });
    });
  }, 120_000);
});
