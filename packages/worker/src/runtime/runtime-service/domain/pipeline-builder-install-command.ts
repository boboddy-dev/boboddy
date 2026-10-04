import { PIPELINE_BUILDER_DIR } from "@boboddy/sdk/push";
import type { ManagedRuntimeDefinition } from "./managed-runtimes";
import {
  selectPipelineBuilderLockfile,
  type PipelineBuilderLockfileName,
} from "./pipeline-builder-lockfiles";

/**
 * The shell command a managed runtime runs (as its `onCreateCommand`) to
 * install `.boboddy/pipeline-builder`'s production dependencies.
 *
 * Never `ci` / `--frozen-lockfile`: the scaffold gitignores lockfiles, so one
 * may be absent or stale. A stale lockfile can make the install fail to
 * resolve; that failure must reach the step's failure message verbatim, so the
 * command chains with `&&` and swallows nothing.
 *
 * Per runtime (proven against every lockfile type):
 *  - `bun`: `bun install --production` always. Bun honors npm, yarn and pnpm
 *    lockfiles.
 *  - `node`: `npm install --omit=dev` honors `package-lock.json` and
 *    `yarn.lock` but silently ignores `pnpm-lock.yaml` (so that one goes
 *    through `corepack pnpm`) and `bun.lock` (so it falls back to a plain
 *    install and says so in the step log).
 *
 * A lockfile the install generates, where the author committed none, is
 * removed afterwards so nothing the author did not write is left in the tree.
 *
 * Pure: `present` is the set of lockfiles found in the clone's builder dir.
 */
export function buildPipelineBuilderInstallCommand(input: {
  present: ReadonlySet<PipelineBuilderLockfileName>;
  definition: ManagedRuntimeDefinition;
}): string {
  const { install, notice, generatedLockfiles } = planInstall(input);
  const removable = generatedLockfiles.filter(
    (name) => !input.present.has(name),
  );
  return [
    `cd ${PIPELINE_BUILDER_DIR}`,
    ...(notice ? [`echo '${notice}' 1>&2`] : []),
    install,
    ...(removable.length > 0 ? [`rm -f ${removable.join(" ")}`] : []),
  ].join(" && ");
}

type InstallPlan = {
  install: string;
  notice: string | null;
  generatedLockfiles: readonly PipelineBuilderLockfileName[];
};

const NPM_INSTALL = "npm install --omit=dev --no-audit --no-fund";

function planInstall(input: {
  present: ReadonlySet<PipelineBuilderLockfileName>;
  definition: ManagedRuntimeDefinition;
}): InstallPlan {
  if (input.definition.runtime === "bun") {
    return {
      install: "bun install --production",
      notice: null,
      generatedLockfiles: ["bun.lock"],
    };
  }

  const lockfile = selectPipelineBuilderLockfile(input.present);
  if (lockfile === "pnpm-lock.yaml") {
    return {
      install: "corepack pnpm install --prod",
      notice: null,
      generatedLockfiles: [],
    };
  }
  const ignoresBunLockfile =
    lockfile === "bun.lock" || lockfile === "bun.lockb";
  return {
    install: NPM_INSTALL,
    notice: ignoresBunLockfile
      ? `boboddy: npm does not read ${lockfile}; installing without it (use the bun1 managed runtime to honor it)`
      : null,
    generatedLockfiles: ["package-lock.json"],
  };
}
