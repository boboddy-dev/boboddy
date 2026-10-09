import { readdirSync } from "node:fs";
import { join } from "node:path";
import { AnalyticsEvents } from "@boboddy/observability/analytics/events";
import {
  buildOpencodeTuiConfig,
  findGitRoot,
  hasFailedExitCode,
  PIPELINE_BUILDER_DIR,
  PIPELINE_DESIGNER_AGENT_NAME,
  resolveBoboddyBaseUrl,
  serializeOpencodeTuiConfig,
  type LaunchOpencodeTuiInput,
  type LaunchOpencodeTuiResult,
} from "@boboddy/worker";
import type { CommandContext } from "./command-output";
import {
  buildPipelineDesignerPrompt,
  PIPELINE_DESIGNER_AGENT_DESCRIPTION,
} from "./design-agent-assets";
import type { DesignPreflightResult } from "./design-preflight";
import type { DesignRunTarget } from "./design-run-offer";
import { readAndConsumeRunOfferGateFailure } from "./design-run-offer-gate-marker";
import {
  buildDesignSeedPrompt,
  hasAuthoredDefinitions,
} from "./design-seed-prompt";
import {
  STUDIO_HANDOFF_MESSAGE,
  type DesignStudioHandle,
} from "./design-studio";
import { resolveCurrentBoboddyCliPath } from "./resolve-cli-path";
import {
  captureMilestone,
  flushTelemetry,
  syncIdentityFromDisk,
} from "./telemetry";

/**
 * The body of `boboddy pipelines design` past the tty check: preflight, the
 * studio companion, the TUI handoff, the run offer, and the exit-code
 * passthrough. Its side effects sit behind {@link DesignSessionPorts}; the
 * real wiring lives in `commands/pipelines-design.ts`.
 */

export interface DesignArguments {
  projectId: string | undefined;
  baseUrl: string | undefined;
  workItemId: string | undefined;
  /** Open the pipeline studio in the browser alongside the session. */
  studio: boolean;
  /**
   * The repository root `.boboddy/` lives in. `init` passes the root it
   * already resolved; standalone runs resolve it from the cwd.
   */
  repoRoot?: string | undefined;
}

/**
 * Where the designer reads and writes. `repoRoot` is `null` outside any git
 * repository, in which case everything falls back to the cwd and scaffolding
 * is refused (see `assertInsideRepository` in `commands/pipelines-design.ts`).
 */
export interface DesignPaths {
  repoRoot: string | null;
  projectRoot: string;
  builderDir: string;
}

/**
 * Resolve the designer's paths: an explicit `repoRoot` wins; otherwise walk up
 * from `cwd` to the nearest git root, so a run from a subdirectory still uses
 * the repository's `.boboddy/`.
 */
export async function resolveDesignPaths(input: {
  repoRoot: string | undefined;
  cwd: string;
}): Promise<DesignPaths> {
  const repoRoot = input.repoRoot ?? (await findGitRoot(input.cwd));
  const projectRoot = repoRoot ?? input.cwd;
  return {
    repoRoot,
    projectRoot,
    builderDir: join(projectRoot, PIPELINE_BUILDER_DIR),
  };
}

/**
 * The builder directory's filenames. Deliberately shallow — the one caller only
 * tailors a seed-prompt flag, so a `readdir` is the entire budget, and a missing
 * directory is simply empty.
 */
function listBuilderFiles(builderDir: string): readonly string[] {
  try {
    return readdirSync(builderDir);
  } catch {
    return [];
  }
}

/**
 * The session's side effects that tests replace: the preflight (network and
 * prompts), the studio, the TUI, the run offer, and the process exit.
 */
export interface DesignSessionPorts {
  preflight(input: {
    baseUrl: string;
    paths: DesignPaths;
    projectIdArgument: string | undefined;
    workItemIdArgument: string | undefined;
  }): Promise<DesignPreflightResult>;
  startStudio(input: {
    builderDir: string;
  }): Promise<DesignStudioHandle | null>;
  launchTui(input: LaunchOpencodeTuiInput): Promise<LaunchOpencodeTuiResult>;
  runOffer(input: {
    baseUrl: string;
    paths: DesignPaths;
    target: DesignRunTarget;
    tuiExitedCleanly: boolean;
  }): Promise<unknown>;
  exit(code: number): void;
}

/**
 * Everything from path resolution to the exit-code passthrough. The studio, a
 * companion and never a gate, starts after the preflight and before the TUI
 * takes the terminal, and stays up through the run offer and its worker.
 */
export async function runDesignSession(input: {
  args: DesignArguments;
  ctx: CommandContext;
  ports: DesignSessionPorts;
}): Promise<void> {
  const { args, ctx, ports } = input;

  const baseUrl = resolveBoboddyBaseUrl(args.baseUrl);
  const paths = await resolveDesignPaths({
    repoRoot: args.repoRoot,
    cwd: process.cwd(),
  });
  const { builderDir } = paths;
  syncIdentityFromDisk(baseUrl);

  ctx.reporter.start("Boboddy pipeline designer");

  const preflight = await ports.preflight({
    baseUrl,
    paths,
    projectIdArgument: args.projectId,
    workItemIdArgument: args.workItemId,
  });

  const studio = args.studio ? await ports.startStudio({ builderDir }) : null;
  if (studio) {
    captureMilestone(AnalyticsEvents.CliStudioOpened, {
      via: "design",
      browser_opened: studio.browserOpened,
    });
  }

  let result: LaunchOpencodeTuiResult;
  try {
    const configContent = serializeOpencodeTuiConfig(
      buildOpencodeTuiConfig({
        agentName: PIPELINE_DESIGNER_AGENT_NAME,
        description: PIPELINE_DESIGNER_AGENT_DESCRIPTION,
        prompt: buildPipelineDesignerPrompt(),
      }),
    );

    // Read after the preflight, which is what creates the directory. The flag
    // discounts the files that same step just scaffolded — see
    // `hasAuthoredDefinitions`.
    //
    // Consumed here too: a PRIOR session's post-push run-offer gate (#146) may
    // have failed after that session's own TUI had already exited, with no
    // live agent left to tell. This is the first moment THIS session can pass
    // that on — see `design-run-offer-gate-marker.ts`.
    const priorRunOfferFailure = readAndConsumeRunOfferGateFailure(builderDir);
    const seedPrompt = buildDesignSeedPrompt({
      workItem: preflight.workItem,
      hasExistingDefinitions: hasAuthoredDefinitions(
        listBuilderFiles(builderDir),
      ),
      priorRunOfferFailure,
    });

    const cliPath = resolveCurrentBoboddyCliPath();
    ctx.logger.info(
      {
        builderDir,
        cliPath,
        projectId: preflight.projectId,
        workItemId: preflight.workItem.id,
        studioUrl: studio?.url ?? null,
        configBytes: Buffer.byteLength(configContent, "utf8"),
        seedPromptBytes: Buffer.byteLength(seedPrompt, "utf8"),
      },
      "Launching the OpenCode TUI",
    );

    // Close the clack block before the child takes over the terminal; a live
    // spinner and a full-screen TUI cannot share a tty.
    ctx.reporter.finish(
      studio
        ? `Starting the designer… ${STUDIO_HANDOFF_MESSAGE}`
        : "Starting the designer…",
    );

    // Milestone 5 — fired right before handing the terminal to the TUI, not
    // after: `launchOpencodeTui` blocks for the whole session, so "after"
    // would only ever fire once the user has already exited.
    captureMilestone(AnalyticsEvents.CliDesignerLaunched, {
      providers: preflight.providers,
    });

    result = await ports.launchTui({
      launcherPath: preflight.launcherPath,
      cwd: builderDir,
      agent: PIPELINE_DESIGNER_AGENT_NAME,
      configContent,
      seedPrompt,
      env: {
        // The agent shells out to the CLI to push; `process.env` is inherited
        // wholesale by the launcher, so TMUX/TMUX_PANE survive untouched.
        BOBODDY_CLI: cliPath,
        BOBODDY_PROJECT_ID: preflight.projectId,
        BOBODDY_BASE_URL: baseUrl,
        ...(studio ? { BOBODDY_STUDIO_URL: studio.url } : {}),
      },
    });

    const target: DesignRunTarget = {
      projectId: preflight.projectId,
      workItemId: preflight.workItem.id,
      workItemTitle: preflight.workItem.title,
    };

    // The session closes its own loop: what was just designed, run on the item
    // it was designed for. See `lib/design-run-offer.ts`.
    await ports.runOffer({
      baseUrl,
      paths,
      target,
      tuiExitedCleanly: result.exitCode === 0,
    });
  } finally {
    await studio?.close();
  }

  if (hasFailedExitCode(result)) {
    // Deliberate exit-code passthrough, matching `pipelines push`. Captured
    // and flushed explicitly first: `process.exit` bypasses `run()` in
    // `cli.ts`, which normally does both.
    captureMilestone(AnalyticsEvents.CliCommandFailed, {
      command: "pipelines design",
      code: "designer_exited_nonzero",
    });
    await flushTelemetry();
    ports.exit(result.exitCode);
  }
}
