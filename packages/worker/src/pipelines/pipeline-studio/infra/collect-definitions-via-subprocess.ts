// The compiled-binary half of `computeStudioSnapshot`'s collection step. See
// `collect-script.ts.tmpl`'s own doc comment for the full "why": a
// `bun build --compile`d binary cannot resolve `@boboddy/sdk`'s
// `exports`-map subpaths from the user's own real, external pipeline-builder
// files, so this spawns a real `bun`/`tsx`/`deno` subprocess (found on the
// user's PATH, never the compiled binary re-executing itself) to do that
// import instead — the same pattern `boboddy pipelines push` already uses
// (`apps/cli/src/commands/pipelines.ts`'s `runPush`).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TolerantCollectedDefinitions } from "@boboddy/sdk/push";
import { detectPipelineRuntime } from "../../pipeline-definitions/infra/detect-pipeline-runtime";
import {
  COLLECT_SCRIPT_FILENAME,
  COLLECT_SCRIPT_TEMPLATE,
} from "./collect-script";

type CollectEnvelope =
  | { ok: true; data: TolerantCollectedDefinitions }
  | { ok: false; message: string; stack?: string };

/** Writes the collect script into `builderDir` only if it isn't already there. */
function ensureCollectScript(builderDir: string): void {
  const scriptPath = join(builderDir, COLLECT_SCRIPT_FILENAME);
  if (existsSync(scriptPath)) return;
  writeFileSync(scriptPath, COLLECT_SCRIPT_TEMPLATE, "utf8");
}

/**
 * Runs the collect script in `builderDir` via a real subprocess and parses
 * its one line of stdout JSON. Throws on any failure (no runtime detected,
 * the subprocess couldn't be spawned, its stdout wasn't parseable JSON, or
 * the script itself reported `ok: false`) — `computeStudioSnapshot`'s own
 * try/catch turns any of these into an `{status: "error"}` snapshot, so no
 * separate error-shape handling is needed here.
 */
export async function collectDefinitionsViaSubprocess(
  builderDir: string,
): Promise<TolerantCollectedDefinitions> {
  const detected = detectPipelineRuntime(builderDir);
  if (!detected.ok) {
    throw new Error(detected.message);
  }
  const { runtime } = detected;

  ensureCollectScript(builderDir);

  const subprocess = Bun.spawn(
    [runtime.command, ...runtime.args, COLLECT_SCRIPT_FILENAME],
    { cwd: builderDir, stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  let envelope: CollectEnvelope;
  try {
    envelope = JSON.parse(stdout.trim()) as CollectEnvelope;
  } catch {
    throw new Error(
      `Failed to parse collect-script output from ${runtime.kind} ` +
        `(exit code ${String(exitCode)}).\n` +
        `stdout: ${stdout.slice(0, 2000) || "(empty)"}\n` +
        `stderr: ${stderr.slice(0, 2000) || "(empty)"}`,
    );
  }

  if (!envelope.ok) {
    // Preserve the subprocess's own stack (from inside the user's real
    // runtime, importing their real files) rather than only the message —
    // `computeStudioSnapshot`'s catch logs `error`'s full stack, and without
    // this the trail goes cold at "collection failed" with no indication of
    // which file/line inside `collectDefinitionsFromDirectory` threw.
    const err = new Error(envelope.message);
    if (envelope.stack) err.stack = envelope.stack;
    throw err;
  }
  return envelope.data;
}
