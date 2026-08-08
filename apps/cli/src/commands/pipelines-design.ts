import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import {
  assertInteractiveTerminal,
  buildOpencodeTuiConfig,
  checkOpencodeProviderCredentials,
  hasDevcontainer,
  launchOpencodeTui,
  loadAuthenticatedSession,
  localConfigSetup,
  PIPELINE_BUILDER_DIR,
  PIPELINE_DESIGNER_AGENT_NAME,
  readProjectConfig,
  resolveBoboddyBaseUrl,
  scaffoldPipelineBuilderDirectory,
  serializeOpencodeTuiConfig,
  verifyRequirements,
} from "@boboddy/worker";
import { version as CLI_VERSION } from "../../package.json";
import { withReporter } from "../lib/command-output";
import {
  buildPipelineDesignerPrompt,
  PIPELINE_DESIGNER_AGENT_DESCRIPTION,
} from "../lib/design-agent-assets";
import {
  runDesignPreflight,
  type DesignPreflightPorts,
} from "../lib/design-preflight";
import {
  promptRunNow,
  queueDesignRun,
  resolveAssignedPipeline,
} from "../lib/design-run-adapters";
import {
  runDesignRunOffer,
  type DesignRunOfferPorts,
  type DesignRunTarget,
} from "../lib/design-run-offer";
import { ensureDesignRuntime } from "../lib/design-runtime";
import {
  buildDesignSeedPrompt,
  hasAuthoredDefinitions,
} from "../lib/design-seed-prompt";
import {
  createDesignWorkItem,
  getDesignWorkItemById,
  listRecentWorkItems,
  promptWorkItemChoice,
  promptWorkItemText,
} from "../lib/design-work-item-adapters";
import { performDeviceLogin } from "../lib/device-login";
import {
  builderDependenciesInstalled,
  NO_PACKAGE_MANAGER_MESSAGE,
  resolveBuilderInstaller,
  runBuilderInstall,
} from "../lib/pipeline-builder-install";
import { resolveCurrentBoboddyCliPath } from "../lib/resolve-cli-path";
import { runWork } from "./work";
import type { CommandContext } from "../lib/command-output";

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

interface DesignArguments {
  projectId: string | undefined;
  baseUrl: string | undefined;
  workItemId: string | undefined;
}

/**
 * A scaffold in the wrong directory is quietly expensive: `pipelines push`
 * resolves the builder directory from the cwd, so a stray
 * `.boboddy/pipeline-builder` in a subdirectory produces confusing failures
 * later. Only enforced when we would actually create the directory.
 */
function assertProjectRoot(cwd: string): void {
  if (existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".boboddy"))) {
    return;
  }
  throw new Error(
    "Run `boboddy pipelines design` from the root of your repository. " +
      `No .git or .boboddy directory was found in ${cwd}.`,
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
 * Identify (or create) the project for this repository and persist it to
 * `.boboddy/boboddy.jsonc` — the same code path `boboddy init` uses, so both
 * entry points agree on how a repo maps to a project.
 */
async function resolveProjectFromRepo(
  baseUrl: string,
): Promise<string | undefined> {
  const { headers, client } = await verifyRequirements({ baseUrl });
  const created = await localConfigSetup({ headers, client });
  return created?.projectId ?? (await readProjectConfig())?.projectId;
}

/** Wire the preflight's ports to their real implementations. */
function buildPorts(
  builderDir: string,
  ctx: CommandContext,
): DesignPreflightPorts {
  return {
    loadSession: async (baseUrl) => {
      const authenticated = await loadAuthenticatedSession(baseUrl);
      return authenticated ? { email: authenticated.session.user.email } : null;
    },
    login: (baseUrl) =>
      performDeviceLogin({
        baseUrl,
        reporter: ctx.reporter,
        logger: ctx.logger,
      }),
    readConfiguredProjectId: async () => (await readProjectConfig())?.projectId,
    resolveProjectFromRepo,
    promptProjectId,
    listWorkItems: listRecentWorkItems,
    getWorkItemById: getDesignWorkItemById,
    promptWorkItemChoice,
    promptWorkItemText,
    createWorkItem: createDesignWorkItem,
    builderDirExists: () => existsSync(builderDir),
    scaffoldBuilderDir: () => {
      assertProjectRoot(process.cwd());
      scaffoldPipelineBuilderDirectory(builderDir, CLI_VERSION);
    },
    dependenciesInstalled: () => builderDependenciesInstalled(builderDir),
    installDependencies: async () => {
      const installer = resolveBuilderInstaller(builderDir);
      if (installer === null) {
        throw new Error(NO_PACKAGE_MANAGER_MESSAGE);
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

/** Wire the closing run offer's ports to their real implementations. */
function buildRunOfferPorts(input: {
  baseUrl: string;
  target: DesignRunTarget;
}): DesignRunOfferPorts {
  const { baseUrl, target } = input;
  return {
    hasDevcontainer: () => hasDevcontainer(process.cwd()),
    resolveAssignedPipeline: () =>
      resolveAssignedPipeline({ baseUrl, projectId: target.projectId }),
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

/**
 * The command body, callable without yargs' argv envelope so `boboddy init`
 * can hand straight over to the designer in-process (see `lib/init-handoff.ts`)
 * instead of re-spawning the CLI.
 */
export const runPipelineDesign = (args: DesignArguments): Promise<void> =>
  withReporter("pipelines-design", async (ctx) => {
    // The TUI owns the terminal; without a real tty it renders into the void.
    assertInteractiveTerminal();

    const baseUrl = resolveBoboddyBaseUrl(args.baseUrl);
    const builderDir = join(process.cwd(), PIPELINE_BUILDER_DIR);

    ctx.reporter.start("Boboddy pipeline designer");

    const preflight = await runDesignPreflight({
      baseUrl,
      projectIdArgument: args.projectId,
      workItemIdArgument: args.workItemId,
      reporter: ctx.reporter,
      ports: buildPorts(builderDir, ctx),
    });

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
    const seedPrompt = buildDesignSeedPrompt({
      workItem: preflight.workItem,
      hasExistingDefinitions: hasAuthoredDefinitions(
        listBuilderFiles(builderDir),
      ),
    });

    const cliPath = resolveCurrentBoboddyCliPath();
    ctx.logger.info(
      {
        builderDir,
        cliPath,
        projectId: preflight.projectId,
        workItemId: preflight.workItem.id,
        configBytes: Buffer.byteLength(configContent, "utf8"),
        seedPromptBytes: Buffer.byteLength(seedPrompt, "utf8"),
      },
      "Launching the OpenCode TUI",
    );

    // Close the clack block before the child takes over the terminal; a live
    // spinner and a full-screen TUI cannot share a tty.
    ctx.reporter.finish("Starting the designer…");

    const result = await launchOpencodeTui({
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
      },
    });

    const target: DesignRunTarget = {
      projectId: preflight.projectId,
      workItemId: preflight.workItem.id,
      workItemTitle: preflight.workItem.title,
    };

    // The session closes its own loop: what was just designed, run on the item
    // it was designed for. See `lib/design-run-offer.ts`.
    await runDesignRunOffer({
      tuiExitedCleanly: result.exitCode === 0,
      target,
      reporter: ctx.reporter,
      ports: buildRunOfferPorts({ baseUrl, target }),
    });

    if (result.exitCode !== null && result.exitCode !== 0) {
      // Deliberate exit-code passthrough, matching `pipelines push`.
      process.exit(result.exitCode);
    }
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
          "from the project's recent items (for one older than the picker shows)",
      }),
  handler: (args: ArgumentsCamelCase<DesignArguments>) =>
    runPipelineDesign(args),
};
