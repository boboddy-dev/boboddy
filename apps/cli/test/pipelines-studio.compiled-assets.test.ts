import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A minimal local stand-in for `@boboddy/pipeline-studio-ui`'s
 * `StudioSnapshot` type — `apps/cli` doesn't depend on that package directly
 * (only `@boboddy/worker` does), so this only types the fields this test
 * actually reads rather than pulling in the real type.
 */
type StudioSnapshotLike =
  | { status: "ok"; pipelines: ReadonlyArray<{ key: string }> }
  | { status: "error"; message: string };

/**
 * Regression test for the "works via `bun run`, breaks in a compiled binary"
 * bug class: `runPipelineStudioServer`'s `resolveStaticDir()`
 * (`packages/worker/src/pipelines/pipeline-studio/application/
 * run-pipeline-studio-server.ts`) resolves `@boboddy/pipeline-studio-ui`'s
 * `dist/` two different ways depending on `Bun.isStandaloneExecutable` —
 * normal package resolution in a source checkout, `join(import.meta.dir,
 * "dist")` inside a compiled binary, where the assets only exist because
 * `apps/cli/script/build.ts` embeds them via `--asset=`. Neither
 * `pipelines-studio.test.ts` (fakes every server port) nor `packages/worker`'s
 * own `run-pipeline-studio-server.test.ts` (real `Bun.serve`, but explicitly
 * skips static-asset serving — see its own doc comment) exercises a real
 * compiled binary, so this exact bug could regress silently.
 *
 * This test builds `@boboddy/pipeline-studio-ui`'s real `dist/`, compiles a
 * throwaway entrypoint into a real standalone executable via `Bun.build`'s
 * `compile` option (mirroring `apps/cli/script/build.ts`'s `--asset=` flag),
 * runs that binary as a subprocess, and asserts the embedded assets come back
 * over real HTTP. It lives here rather than under `packages/worker/tests/`
 * because it is fundamentally testing `apps/cli`'s packaging output (the
 * `--asset` embedding mechanism), not `run-pipeline-studio-server.ts`'s
 * application logic.
 *
 * Plain `test()`, not `test.concurrent`: this compiles a real binary and
 * binds a real port, closer to the "real infrastructure" category
 * `run-pipeline-studio-server.test.ts` already uses plain `test()` for.
 */

const repoRoot = resolve(import.meta.dir, "../../..");
const pipelineStudioUiDir = resolve(repoRoot, "packages/pipeline-studio-ui");
const pipelineStudioUiDistDir = resolve(pipelineStudioUiDir, "dist");

/** The throwaway compiled entrypoint's source. Reads `builderDir` from argv,
 * starts the real studio server, and prints its URL so the test can read it
 * off the subprocess's stdout. */
const ENTRY_SOURCE = `import { runPipelineStudioServer } from "@boboddy/worker";

const builderDir = process.argv[2];
if (!builderDir) throw new Error("Usage: entry <builderDir>");

const handle = await runPipelineStudioServer({ builderDir });
process.stdout.write(\`STUDIO_URL:\${handle.url}\\n\`);
`;

/** Reads the compiled entrypoint's stdout until it prints the server's URL. */
async function readStudioUrl(
  stdout: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(
        `Compiled binary exited before printing its URL. Output so far: ${buffer}`,
      );
    }
    buffer += decoder.decode(value, { stream: true });
    const match = /STUDIO_URL:(\S+)/.exec(buffer);
    if (match?.[1]) return match[1];
  }
}

describe("boboddy pipelines studio — compiled binary asset embedding", () => {
  test(
    "a `bun build --compile`d binary serves the real embedded pipeline-studio-ui assets",
    async () => {
      // 1. Build @boboddy/pipeline-studio-ui's real dist/ — the assets this
      // test verifies actually make it into the compiled binary.
      const uiBuild = Bun.spawn(["bun", "run", "build.ts"], {
        cwd: pipelineStudioUiDir,
        stdout: "inherit",
        stderr: "inherit",
      });
      expect(await uiBuild.exited).toBe(0);

      // 2. Write a throwaway entrypoint. It must live inside this workspace
      // (a subdirectory of apps/cli), not the system temp dir — Bun's
      // workspace-aware resolver only finds `@boboddy/worker` for files
      // reachable from a workspace member's own directory tree.
      const entryDir = mkdtempSync(
        join(import.meta.dir, "compiled-assets-entry-"),
      );
      const outfile = join(entryDir, "studio-server-bin");
      let subprocess: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
      const builderDir = mkdtempSync(
        join(tmpdir(), "boboddy-compiled-studio-builder-"),
      );

      try {
        writeFileSync(join(entryDir, "entry.ts"), ENTRY_SOURCE, "utf8");

        // 3. Compile it exactly as `apps/cli/script/build.ts` compiles the
        // real CLI: `--asset=<pipeline-studio-ui's dist/>`, expressed here
        // via the JS `Bun.build` API's `compile.assets` (equivalent to the
        // `--asset` CLI flag, repeatable).
        const buildResult = await Bun.build({
          entrypoints: [join(entryDir, "entry.ts")],
          target: "bun",
          compile: {
            outfile,
            assets: [pipelineStudioUiDistDir],
          },
        });
        if (!buildResult.success) {
          throw new Error(
            `Compile failed:\n${buildResult.logs.map(String).join("\n")}`,
          );
        }

        // 4. Run the compiled binary and read the server's URL off its stdout.
        subprocess = Bun.spawn([outfile, builderDir], {
          stdout: "pipe",
          stderr: "inherit",
        });
        const url = await readStudioUrl(subprocess.stdout);

        // 5. Fetch real embedded assets over real HTTP.
        const indexResponse = await fetch(`${url}/`);
        expect(indexResponse.status).toBe(200);
        expect(indexResponse.headers.get("content-type")).toContain(
          "text/html",
        );
        const indexBody = await indexResponse.text();
        expect(indexBody).toContain("<title>Boboddy Pipeline Studio</title>");

        const scriptResponse = await fetch(`${url}/main.js`);
        expect(scriptResponse.status).toBe(200);
        expect(scriptResponse.headers.get("content-type")).toContain(
          "javascript",
        );
        const scriptBody = await scriptResponse.text();
        expect(scriptBody.length).toBeGreaterThan(0);
      } finally {
        subprocess?.kill();
        await subprocess?.exited;
        rmSync(entryDir, { recursive: true, force: true });
        rmSync(builderDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

/**
 * Regression test for the "compiled `boboddy` binary can't resolve
 * `@boboddy/sdk`'s `exports`-map subpaths for the user's own external
 * pipeline-builder files" bug class (see `compute-studio-snapshot.ts`'s own
 * doc comment) — the actual bug this ticket's Phase 3 fixed via
 * `collectDefinitionsViaSubprocess`.
 *
 * Deliberately uses a REAL, `node_modules`-installed `@boboddy/sdk` built
 * from a real `bun pm pack` tarball (via `packages/sdks/js`'s own
 * `pack:local` script), not a workspace symlink — a `bun link` would resolve
 * `@boboddy/sdk` back to this repo's own workspace member and would not
 * faithfully reproduce the original bug (an external, real npm-installed
 * copy failing to resolve from inside a compiled binary).
 */
describe("boboddy pipelines studio — compiled binary resolving a real, external @boboddy/sdk", () => {
  const zodVersion = (
    JSON.parse(
      readFileSync(
        resolve(repoRoot, "packages/sdks/js/package.json"),
        "utf8",
      ),
    ) as { devDependencies: { zod: string } }
  ).devDependencies.zod;

  const PIPELINE_SOURCE = `import { defineStep } from "@boboddy/sdk/definitions/steps";
import { definePipeline } from "@boboddy/sdk/definitions/pipelines";

const analyzeStep = defineStep({
  key: "analyze-step",
  name: "Analyze",
  agentPrompt: "Analyze the pull request.",
});

export default definePipeline({
  key: "review-pr",
  startAt: "analyze",
  states: {
    analyze: { kind: "step", step: analyzeStep, next: "done" },
    done: { kind: "succeed" },
  },
});
`;

  /** Reads one `data: {...}\n\n` SSE frame from a stream reader — mirrors
   * `run-pipeline-studio-server.test.ts`'s own helper of the same name. */
  async function readOneSnapshot(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<StudioSnapshotLike> {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("Stream closed before a full SSE frame arrived");
      }
      buffer += decoder.decode(value, { stream: true });
      const frameEnd = buffer.indexOf("\n\n");
      if (frameEnd === -1) continue;
      const frame = buffer.slice(0, frameEnd);
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) throw new Error(`Malformed SSE frame: ${frame}`);
      return JSON.parse(dataLine.slice("data: ".length)) as StudioSnapshotLike;
    }
  }

  test(
    "collects a pipeline that imports a real, node_modules-installed @boboddy/sdk",
    async () => {
      const sdkDir = resolve(repoRoot, "packages/sdks/js");
      let tarballPath: string | undefined;
      let entryDir: string | undefined;
      let builderDir: string | undefined;
      let subprocess: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;

      try {
        // 1. Build a real, installable @boboddy/sdk tarball. `pack:local`
        // logs human-facing build output to stderr and prints only the
        // tarball's absolute path to stdout, as its last line — see the
        // script's own doc comment. Don't second-guess this convention.
        const pack = Bun.spawn(["bun", "run", "pack:local"], {
          cwd: sdkDir,
          stdout: "pipe",
          stderr: "inherit",
        });
        const packStdout = await new Response(pack.stdout).text();
        expect(await pack.exited).toBe(0);
        const lines = packStdout.trim().split(/\r?\n/u).filter(Boolean);
        tarballPath = lines.at(-1);
        if (!tarballPath?.endsWith(".tgz")) {
          throw new Error(
            `Expected pack:local's last stdout line to be a .tgz path, got: ${packStdout}`,
          );
        }

        // 2. Build a standalone fixture package — NOT under this repo's own
        // directory tree, so Bun's workspace resolution can't interfere —
        // that depends on the real tarball via a `file:` dependency, plus a
        // real `zod` (a peerDependency of @boboddy/sdk, so it must be
        // supplied directly by the fixture's own package.json).
        builderDir = mkdtempSync(
          join(tmpdir(), "boboddy-real-sdk-import-builder-"),
        );
        writeFileSync(
          join(builderDir, "package.json"),
          JSON.stringify(
            {
              name: "boboddy-real-sdk-import-fixture",
              private: true,
              type: "module",
              dependencies: {
                "@boboddy/sdk": `file:${tarballPath}`,
                zod: zodVersion,
              },
            },
            null,
            2,
          ),
          "utf8",
        );
        writeFileSync(
          join(builderDir, "review-pr.ts"),
          PIPELINE_SOURCE,
          "utf8",
        );

        // A real `bun install` produces a real `bun.lock` (so
        // `detectPipelineRuntime` picks the `bun` branch automatically) and
        // a real `node_modules/@boboddy/sdk` + `node_modules/zod`.
        const install = Bun.spawn(["bun", "install"], {
          cwd: builderDir,
          stdout: "inherit",
          stderr: "inherit",
        });
        expect(await install.exited).toBe(0);

        // 3. Compile a throwaway entrypoint into a real standalone
        // executable, exactly like the test above.
        entryDir = mkdtempSync(
          join(import.meta.dir, "real-sdk-import-entry-"),
        );
        const outfile = join(entryDir, "studio-server-bin");
        writeFileSync(join(entryDir, "entry.ts"), ENTRY_SOURCE, "utf8");

        const buildResult = await Bun.build({
          entrypoints: [join(entryDir, "entry.ts")],
          target: "bun",
          compile: { outfile },
        });
        if (!buildResult.success) {
          throw new Error(
            `Compile failed:\n${buildResult.logs.map(String).join("\n")}`,
          );
        }

        // 4. Run the compiled binary against the real, populated builderDir.
        subprocess = Bun.spawn([outfile, builderDir], {
          stdout: "pipe",
          stderr: "inherit",
        });
        const url = await readStudioUrl(subprocess.stdout);

        // 5. Fetch one real snapshot over SSE.
        const response = await fetch(`${url}/api/stream`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Expected a readable SSE body");
        const snapshot = await readOneSnapshot(reader);
        await reader.cancel();

        if (snapshot.status !== "ok") {
          throw new Error(
            `Expected an "ok" snapshot, got "error": ${snapshot.message}`,
          );
        }
        expect(snapshot.status).toBe("ok");
        expect(
          snapshot.pipelines.some((pipeline) => pipeline.key === "review-pr"),
        ).toBe(true);
      } finally {
        subprocess?.kill();
        await subprocess?.exited;
        if (entryDir) rmSync(entryDir, { recursive: true, force: true });
        if (builderDir) rmSync(builderDir, { recursive: true, force: true });
        if (tarballPath) rmSync(tarballPath, { force: true });
      }
    },
    120_000,
  );
});
