import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { existsSync } from "node:fs";
import * as clack from "@clack/prompts";
import {
  assertInteractiveTerminal,
  checkOpencodeProviderCredentials,
  detectInstalledAiTools,
  hasDevcontainer,
  launchOpencodeTui,
  localConfigSetup,
  readProjectConfig,
  runPipelineStudioServer,
  scaffoldPipelineBuilderDirectory,
  verifyRequirements,
} from "@boboddy/worker";
import { version as CLI_VERSION } from "../../package.json";
import { openBrowser } from "../auth/browser";
import { withReporter } from "../lib/command-output";
import {
  runDesignPreflight,
  type DesignPreflightPorts,
} from "../lib/design-preflight";
import { runOpencodeAuthLogin } from "../lib/design-provider-connect";
import {
  pipelineNeedsProjectDevcontainer,
  promptRunNow,
  queueDesignRun,
  resolveAssignedPipeline,
  runFirstStepDryRun,
} from "../lib/design-run-adapters";
import {
  runDesignRunOffer,
  type DesignRunOfferPorts,
  type DesignRunTarget,
} from "../lib/design-run-offer";
import { ensureDesignRuntime } from "../lib/design-runtime";
import {
  runDesignSession,
  type DesignArguments,
  type DesignPaths,
  type DesignSessionPorts,
} from "../lib/design-session";
import { startDesignStudio, type DesignStudioPorts } from "../lib/design-studio";
import {
  createDesignWorkItem,
  findWorkItemByUrl,
  getDesignWorkItemById,
  listRecentWorkItems,
  promptWorkItemChoice,
  promptWorkItemSearch,
  promptWorkItemText,
} from "../lib/design-work-item-adapters";
import { createSignInPorts } from "../lib/ensure-signed-in";
import {
  builderDependenciesInstalled,
  NO_PACKAGE_MANAGER_MESSAGE,
  resolveBuilderInstaller,
  runBuilderInstall,
} from "../lib/pipeline-builder-install";
import { runWork } from "./work";
import type { CommandContext } from "../lib/command-output";
import type { BaseReporter } from "../lib/reporter-types";
import { CliError } from "../lib/cli-error";

/**
 * `boboddy pipelines design` — the guided path from "I have a repo" to "I have
 * a pipeline running against it".
 *
 * It provisions and launches the real OpenCode TUI, in the user's
 * `.boboddy/pipeline-builder` directory, booted into an injected
 * `pipeline-designer` agent that interviews them and writes the definitions.
 * Everything before the launch is preflight, and every preflight step heals
 * itself rather than printing a "run X first" instruction — see
 * `lib/design-preflight.ts`.
 */

/**
 * A scaffold outside a repository has no root to anchor `.boboddy/` to. Only
 * enforced when we would actually create the directory.
 */
function assertInsideRepository(paths: DesignPaths, cwd: string): void {
  if (paths.repoRoot !== null) {
    return;
  }
  throw new CliError(
    "not_in_git_repo",
    "Run `boboddy pipelines design` from inside your project's git repository. " +
      `No git repository was found at or above ${cwd}.`,
  );
}

/**
 * The last-resort prompt, reached only when the repository could not be matched
 * to a project (see `lib/design-preflight.ts`). It validates rather than
 * accepting an empty line, so a stray Enter re-asks instead of aborting the run.
 */
async function promptProjectId(): Promise<string | undefined> {
  const answer = await clack.text({
    message:
      "Paste a project ID from the Boboddy dashboard (Ctrl+C to cancel):",
    validate: (value) =>
      (value ?? "").trim().length === 0
        ? "Enter a project ID, or press Ctrl+C."
        : undefined,
  });
  if (clack.isCancel(answer)) {
    return undefined;
  }
  return answer;
}

/**
 * Identify the project for this repository and persist it to
 * `.boboddy/boboddy.jsonc` — the same code path `boboddy init` uses, so both
 * entry points agree on how a repo maps to a project.
 *
 * Unlike `init`, this does NOT send the user to a browser hand-off when no
 * project matches yet (#141) — `pipelines design` is meant to drop straight
 * into a TUI session, which doesn't compose with waiting on a browser tab and
 * a keypress. `undefined` here just means "not found the easy way"; the
 * caller's existing fallback ladder (see `design-preflight.ts`) degrades to
 * prompting for a project id, same as the no-remote case always has.
 */
async function resolveProjectFromRepo(
  baseUrl: string,
  projectRoot: string,
): Promise<string | undefined> {
  const { headers, client } = await verifyRequirements({ baseUrl });
  const result = await localConfigSetup({
    headers,
    client,
    rootDir: projectRoot,
  });
  if (result.status === "matched") return result.projectId;
  if (result.status === "already-configured") {
    return (await readProjectConfig(projectRoot))?.projectId;
  }
  return undefined;
}

/**
 * Wire the preflight's ports to their real implementations. Exported so the
 * path wiring — which root each port reads and writes — is testable.
 */
export function buildDesignPreflightPorts(
  paths: DesignPaths,
  ctx: CommandContext,
): DesignPreflightPorts {
  const { builderDir, projectRoot } = paths;
  return {
    ...createSignInPorts({ reporter: ctx.reporter, logger: ctx.logger }),
    readConfiguredProjectId: async () =>
      (await readProjectConfig(projectRoot))?.projectId,
    resolveProjectFromRepo: (baseUrl) =>
      resolveProjectFromRepo(baseUrl, projectRoot),
    promptProjectId,
    listWorkItems: listRecentWorkItems,
    getWorkItemById: getDesignWorkItemById,
    findWorkItemByUrl,
    promptWorkItemChoice,
    promptWorkItemSearch,
    promptWorkItemText,
    createWorkItem: createDesignWorkItem,
    builderDirExists: () => existsSync(builderDir),
    scaffoldBuilderDir: () => {
      assertInsideRepository(paths, process.cwd());
      scaffoldPipelineBuilderDirectory(builderDir, CLI_VERSION);
    },
    dependenciesInstalled: () => builderDependenciesInstalled(builderDir),
    installDependencies: async () => {
      const installer = resolveBuilderInstaller(builderDir);
      if (installer === null) {
        throw new CliError("no_package_manager", NO_PACKAGE_MANAGER_MESSAGE);
      }
      ctx.logger.info(
        { installer: installer.label, builderDir },
        "Installing pipeline builder dependencies",
      );
      await runBuilderInstall({ builderDir, installer });
    },
    ensureRuntime: () => ensureDesignRuntime({ reporter: ctx.reporter }),
    checkCredentials: (launcherPath) =>
      checkOpencodeProviderCredentials({ launcherPath }),
    detectInstalledTools: () => detectInstalledAiTools({}),
    runAuthLogin: runOpencodeAuthLogin,
  };
}

/** Wire the closing run offer's ports to their real implementations. */
function buildRunOfferPorts(input: {
  baseUrl: string;
  target: DesignRunTarget;
  paths: DesignPaths;
  reporter: BaseReporter;
}): DesignRunOfferPorts {
  const { baseUrl, target, paths, reporter } = input;
  const { builderDir } = paths;
  return {
    resolveAssignedPipeline: () =>
      resolveAssignedPipeline({ baseUrl, projectId: target.projectId }),
    pipelineNeedsProjectDevcontainer: (pipelineDefinitionId) =>
      pipelineNeedsProjectDevcontainer({ baseUrl, pipelineDefinitionId }),
    hasDevcontainer: () => hasDevcontainer(paths.projectRoot),
    runFirstStepDryRun: (pipelineDefinitionId) =>
      runFirstStepDryRun({
        baseUrl,
        projectId: target.projectId,
        pipelineDefinitionId,
        builderDir,
        reporter,
      }),
    confirmRun: promptRunNow,
    queueRun: (pipelineDefinitionId) =>
      queueDesignRun({
        baseUrl,
        projectId: target.projectId,
        workItemId: target.workItemId,
        pipelineDefinitionId,
      }),
    // Everything else takes its flag default — including `once: false`, so the
    // worker keeps polling: later steps are only queued as earlier ones advance,
    // and a single pass would stop after the first. The user stops it when they
    // have seen enough.
    runWorker: () =>
      runWork({
        projectId: target.projectId,
        baseUrl,
        workItemId: target.workItemId,
      }),
  };
}

function buildStudioPorts(): DesignStudioPorts {
  return {
    startServer: ({ builderDir }) => runPipelineStudioServer({ builderDir }),
    openBrowser,
  };
}

/** Wire the session's ports to their real implementations. */
function buildDesignSessionPorts(
  ctx: CommandContext,
): DesignSessionPorts {
  return {
    preflight: ({ baseUrl, paths, projectIdArgument, workItemIdArgument }) =>
      runDesignPreflight({
        baseUrl,
        projectIdArgument,
        workItemIdArgument,
        reporter: ctx.reporter,
        ports: buildDesignPreflightPorts(paths, ctx),
      }),
    startStudio: ({ builderDir }) =>
      startDesignStudio({
        builderDir,
        reporter: ctx.reporter,
        ports: buildStudioPorts(),
      }),
    launchTui: launchOpencodeTui,
    runOffer: ({ baseUrl, paths, target, tuiExitedCleanly }) =>
      runDesignRunOffer({
        tuiExitedCleanly,
        target,
        reporter: ctx.reporter,
        ports: buildRunOfferPorts({
          baseUrl,
          target,
          paths,
          reporter: ctx.reporter,
        }),
      }),
    exit: (code) => process.exit(code),
  };
}

/**
 * The command body, callable without yargs' argv envelope so `boboddy init`
 * can hand straight over to the designer in-process (see `lib/init-handoff.ts`)
 * instead of re-spawning the CLI.
 */
export const runPipelineDesign = (args: DesignArguments): Promise<void> =>
  withReporter("pipelines-design", async (ctx) => {
    // The TUI owns the terminal; without a real tty it renders into the void.
    assertInteractiveTerminal();
    await runDesignSession({
      args,
      ctx,
      ports: buildDesignSessionPorts(ctx),
    });
  });

export const designCommand: CommandModule<object, DesignArguments> = {
  command: "design [projectId]",
  describe: "Interactively design pipelines with an AI agent, then push them",
  builder: (argv: Argv<object>) =>
    argv
      .positional("projectId", {
        describe:
          "The project to design pipelines for (defaults to the id in .boboddy/boboddy.jsonc)",
        type: "string",
      })
      .option("baseUrl", {
        alias: "base-url",
        type: "string",
        describe: "Boboddy app base URL",
      })
      .option("workItemId", {
        alias: "work-item-id",
        type: "string",
        describe:
          "Design around this specific work item ID instead of picking " +
          "from the project's recent items (for one older than the picker " +
          "shows). Falls back to the picker if the id doesn't resolve",
      })
      .option("studio", {
        type: "boolean",
        default: true,
        describe:
          "Open the live pipeline graph in your browser alongside the session (--no-studio to skip)",
      }),
  handler: (args: ArgumentsCamelCase<DesignArguments>) =>
    runPipelineDesign(args),
};
