// The offline half of `boboddy pipelines studio`: turn a snapshot of
// `.boboddy/pipeline-builder` into the payload the SSE stream sends. Every
// step here is the same pure/offline pipeline `boboddy pipelines push`
// already relies on (`collectDefinitionsFromDirectory`'s tolerant sibling,
// `collectDefinitionsFromDirectoryTolerant`, + `validateDefinitionSpecs` —
// see that command's own doc comment) — no network call, no token, matching
// the plan's explicit "no network call" framing for the designer. In a
// compiled binary, collection itself is routed through a subprocess rather
// than done in-process — see `collectDefinitions()`/
// `collectDefinitionsViaSubprocess` below — but the no-network-call,
// no-token framing above still holds either way.
import { createLazyLogger } from "@boboddy/observability/logging/host";
import { translatePipelineToSnapshot } from "@boboddy/pipeline-studio-ui";
import type { StudioSnapshot } from "@boboddy/pipeline-studio-ui";
import { collectDefinitionsFromDirectoryTolerant } from "@boboddy/sdk/push";
import type { TolerantCollectedDefinitions } from "@boboddy/sdk/push";
import { validateDefinitionSpecs } from "@boboddy/sdk/definitions/validation";
import { collectDefinitionsViaSubprocess } from "../infra/collect-definitions-via-subprocess";

const logger = createLazyLogger({
  name: "@boboddy/worker",
  scope: "pipeline-studio",
});

/**
 * Known-pipeline-keys tradeoff: `validateDefinitionSpecs`'s `route-target`
 * check normally also accepts pipeline keys that only exist on the SERVER
 * (`options.knownPipelineKeys`) — resolving those requires a network call,
 * which this command deliberately never makes (see the file-top comment).
 * Passing an empty array here means a `next: { routeToPipeline: "..." }`
 * target that is real, but only pushed in an EARLIER session and not
 * present in the current local directory, gets flagged as an issue even
 * though it would resolve fine server-side. Acceptable for a v1, read-only,
 * local-only designer — surfaced explicitly here and in the phase report
 * rather than silently swallowed.
 */
const NO_KNOWN_PIPELINE_KEYS: readonly string[] = [];

/**
 * A `bun build --compile`d binary can't resolve `@boboddy/sdk`'s
 * `exports`-map subpaths for the user's own real, external pipeline-builder
 * files (confirmed directly — `require`, `createRequire(...)(...)`, and
 * `Bun.resolveSync(...)` all fail identically), so collection has to happen
 * differently depending on how this code itself is currently running:
 *
 * - Compiled (`Bun.isStandaloneExecutable`): spawn a real bun/tsx/deno
 *   subprocess found on the user's PATH to do the import — see
 *   `collect-definitions-via-subprocess.ts`.
 * - Source checkout / `bun run` (dev, tests): import directly, in-process,
 *   exactly as before — there's no resolution problem to work around.
 */
function collectDefinitions(
  builderDir: string,
): Promise<TolerantCollectedDefinitions> {
  return Bun.isStandaloneExecutable
    ? collectDefinitionsViaSubprocess(builderDir)
    : collectDefinitionsFromDirectoryTolerant(builderDir);
}

/**
 * Collects, validates, and translates every pipeline in `builderDir` into the
 * shape `run-pipeline-studio-server.ts` broadcasts over SSE. Never throws.
 *
 * Collection itself (`collectDefinitionsFromDirectoryTolerant`) already
 * isolates per-file failures into `brokenPipelines` rather than throwing, so
 * one bad edit only takes down that one pipeline's entry — every other
 * pipeline still renders. The outer try/catch below only remains for
 * failures collection can't attribute to a single file at all (the
 * directory itself vanishing, an undetectable runtime in a compiled binary,
 * a malformed collect-script subprocess response, ...), which still turn
 * into a whole-snapshot `{status: "error"}` — there is no single pipeline to
 * blame those on.
 */
export async function computeStudioSnapshot(
  builderDir: string,
): Promise<StudioSnapshot> {
  const collectedAt = new Date().toISOString();

  try {
    const collected = await collectDefinitions(builderDir);
    const issues = validateDefinitionSpecs(
      { pipelines: collected.pipelines, steps: collected.steps },
      { knownPipelineKeys: NO_KNOWN_PIPELINE_KEYS },
    );
    const pipelines = collected.pipelines.map((spec) =>
      translatePipelineToSnapshot(spec, issues),
    );

    return {
      status: "ok",
      pipelines,
      brokenPipelines: collected.brokenPipelines,
      validationIssues: issues,
      collectedAt,
    };
  } catch (error) {
    // Never rethrows (see the doc comment above), but a silently-swallowed
    // error is undebuggable — log the full error (stack included, via pino's
    // default `err` serializer) so `--verbose` and the log file both capture
    // it, even though only `error.message` reaches the browser via the SSE
    // snapshot below.
    logger.error({ err: error }, "Failed to compute pipeline studio snapshot");
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      collectedAt,
    };
  }
}
