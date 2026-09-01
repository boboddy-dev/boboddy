import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { AnalyticsEvents } from "@boboddy/observability/analytics/events";
import {
  detectPipelineRuntime,
  listExistingPipelineBuilderFiles,
  loadAuthenticatedSession,
  PIPELINE_BUILDER_DIR,
  pullPipelineDefinitions,
  readProjectConfig,
  resolveBoboddyBaseUrl,
  scaffoldPipelineBuilderDirectory,
  STARTER_PIPELINE_FILENAME,
} from "@boboddy/worker";
import { version as CLI_VERSION } from "../../package.json";
import { designCommand } from "./pipelines-design";
import { studioCommand } from "./pipelines-studio";
import { withReporter } from "../lib/command-output";
import {
  captureMilestone,
  flushTelemetry,
  syncIdentityFromDisk,
} from "../lib/telemetry";
import {
  PUSH_SCRIPT_FILENAME,
  PUSH_SCRIPT_TEMPLATE,
} from "../templates/push-script";

// init

const runInit = (): Promise<void> =>
  withReporter("pipelines-init", ({ reporter, logger }) => {
    if (!existsSync(join(process.cwd(), ".git"))) {
      throw new Error(
        "`boboddy pipelines init` must be run from the root of a git repository. Navigate to your repo root and try again.",
      );
    }

    const dir = join(process.cwd(), PIPELINE_BUILDER_DIR);
    const result = scaffoldPipelineBuilderDirectory(dir, CLI_VERSION);

    for (const file of result.created) {
      reporter.success(`Created ${file}`);
    }
    for (const file of result.skipped) {
      reporter.warn(`Skipped ${file} (already exists)`);
    }

    logger.info(
      { dir, created: result.created, skipped: result.skipped },
      "Pipeline builder scaffolded",
    );

    reporter.info(
      `Pipeline builder scaffolded at ${PIPELINE_BUILDER_DIR}. Next steps:
  1. cd ${PIPELINE_BUILDER_DIR} && npm install   (or bun install)
  2. open ${STARTER_PIPELINE_FILENAME} — the starter pipeline is a guided tour
  3. boboddy pipelines push
  4. create a work item, then run \`boboddy work\` and watch it advance`,
    );
  });

const initCommand: CommandModule<object, object> = {
  command: "init",
  describe: `Scaffold ${PIPELINE_BUILDER_DIR} with an example pipeline`,
  builder: (argv) => argv,
  handler: runInit,
};

// push

interface PushArguments {
  projectId: string | undefined;
  baseUrl: string | undefined;
}

const runPush = (args: ArgumentsCamelCase<PushArguments>): Promise<void> =>
  withReporter("pipelines-push", async ({ reporter, logger }) => {
    const baseUrl = resolveBoboddyBaseUrl(args.baseUrl);

    const projectId = args.projectId ?? (await readProjectConfig())?.projectId;
    if (!projectId) {
      throw new Error(
        "No project ID provided. Pass one as an argument or run `boboddy init` first.",
      );
    }

    const authenticated = await loadAuthenticatedSession(baseUrl);
    if (!authenticated) {
      throw new Error(
        `Not signed in to ${baseUrl}. Run \`boboddy auth login\` first.`,
      );
    }
    syncIdentityFromDisk(baseUrl);

    const dir = join(process.cwd(), PIPELINE_BUILDER_DIR);

    if (!existsSync(dir)) {
      throw new Error(
        `Pipeline builder directory not found at ${PIPELINE_BUILDER_DIR}. ` +
          "Run `boboddy pipelines init` first.",
      );
    }

    // Without node_modules, the user's pipeline files can't import @boboddy/sdk
    // (or anything else). Bail with a clear hint before we even pick a runtime.
    if (!existsSync(join(dir, "node_modules", "@boboddy", "sdk"))) {
      throw new Error(
        `Missing dependencies in ${PIPELINE_BUILDER_DIR}. ` +
          "Run `bun install` / `npm install` / `pnpm install` / `yarn install` " +
          "inside that directory first.",
      );
    }

    const detected = detectPipelineRuntime(dir);
    if (!detected.ok) {
      throw new Error(detected.message);
    }
    const { runtime } = detected;

    // Overwrite the script every push so the user never runs a stale version.
    const scriptPath = join(dir, PUSH_SCRIPT_FILENAME);
    writeFileSync(scriptPath, PUSH_SCRIPT_TEMPLATE, "utf8");

    logger.info(
      { runtime: runtime.kind, script: PUSH_SCRIPT_FILENAME },
      `Running ${runtime.kind} on ${PUSH_SCRIPT_FILENAME}…`,
    );

    // The script reads auth from the same file the CLI writes, and projectId
    // from .boboddy/boboddy.jsonc — both already resolved above to fail fast.
    // We forward overrides via env vars so positional CLI args still take effect.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BOBODDY_PROJECT_ID: projectId,
      BOBODDY_BASE_URL: baseUrl,
      BOBODDY_ACCESS_TOKEN: authenticated.profile.accessToken,
    };

    const task = reporter.startTask(
      `Running ${runtime.kind} on ${PUSH_SCRIPT_FILENAME}…`,
    );

    const exitCode = await new Promise<number>((resolvePromise) => {
      const child = spawn(
        runtime.command,
        [...runtime.args, PUSH_SCRIPT_FILENAME],
        { cwd: dir, stdio: "inherit", env },
      );
      child.on("error", (err: Error) => {
        logger.error({ err }, `Failed to start ${runtime.command}.`);
        resolvePromise(1);
      });
      child.on("exit", (code: number | null) => {
        resolvePromise(code ?? 1);
      });
    });

    if (exitCode !== 0) {
      task.fail(`Push failed (exit ${String(exitCode)})`);
      // Passthrough the child's exact exit code (deliberate exit-code
      // passthrough; not forced to 1). Flushed explicitly first:
      // `process.exit` bypasses the `finally` in `index.ts` that normally
      // does this.
      await flushTelemetry();
      process.exit(exitCode);
    }

    task.succeed("Pushed pipeline definitions");
    captureMilestone(AnalyticsEvents.CliPipelinePushed);
  });

const pushCommand: CommandModule<object, PushArguments> = {
  command: "push [projectId]",
  describe: `Push pipeline definitions from ${PIPELINE_BUILDER_DIR} to the server`,
  builder: (argv: Argv<object>) =>
    argv
      .positional("projectId", {
        describe:
          "The project to push pipelines to (defaults to the id in .boboddy/boboddy.jsonc)",
        type: "string",
      })
      .option("baseUrl", {
        alias: "base-url",
        type: "string",
        describe: "Boboddy app base URL",
      }),
  handler: runPush,
};

// pull

async function confirmOverwrite(files: string[]): Promise<boolean> {
  if (files.length === 0) return true;

  // clack prompts need a TTY; off-TTY, proceed (the server is the source of
  // truth for pull) rather than hang.
  if (!process.stdin.isTTY) return true;

  const list = files.map((f) => `  - ${f}`).join("\n");
  const answer = await clack.confirm({
    message: `The following files will be overwritten:\n${list}\n\nContinue?`,
    initialValue: true,
  });

  // Treat cancellation as "no" so the existing "Pull cancelled." path runs.
  if (clack.isCancel(answer)) return false;
  return answer;
}

interface PullArguments {
  projectId: string | undefined;
  baseUrl: string | undefined;
}

const runPull = (args: ArgumentsCamelCase<PullArguments>): Promise<void> =>
  withReporter("pipelines-pull", async ({ reporter, logger }) => {
    const baseUrl = resolveBoboddyBaseUrl(args.baseUrl);

    const projectId = args.projectId ?? (await readProjectConfig())?.projectId;
    if (!projectId) {
      throw new Error(
        "No project ID provided. Pass one as an argument or run `boboddy init` first.",
      );
    }

    const authenticated = await loadAuthenticatedSession(baseUrl);
    if (!authenticated) {
      throw new Error(
        `Not signed in to ${baseUrl}. Run \`boboddy auth login\` first.`,
      );
    }

    const headers = {
      Authorization: `Bearer ${authenticated.profile.accessToken}`,
    };
    const dir = join(process.cwd(), PIPELINE_BUILDER_DIR);

    const existingFiles = listExistingPipelineBuilderFiles(dir);
    const confirmed = await confirmOverwrite(existingFiles);
    if (!confirmed) {
      reporter.info("Pull cancelled.");
      return;
    }

    const result = await pullPipelineDefinitions({
      projectId,
      baseUrl,
      headers,
      logger,
      dir,
      sdkVersion: CLI_VERSION,
    });

    if (
      result.stepFiles === 0 &&
      result.pipelineFiles === 0 &&
      !result.defaultPipelineAssignmentFile
    )
      return;

    const freshlyScaffolded = existingFiles.length === 0;
    if (freshlyScaffolded) {
      reporter.info(
        `Run \`npm install\` or \`bun install\` inside ${PIPELINE_BUILDER_DIR} to install dependencies.`,
      );
    }

    const assignmentMsg = result.defaultPipelineAssignmentFile
      ? ", default-pipeline-assignment.ts"
      : "";
    const fieldsMsg = result.workItemFieldsFile ? ", work-item-fields.ts" : "";
    reporter.success(
      `Pull complete. ${String(result.pipelineFiles)} pipeline file(s), ${String(result.stepFiles)} step file(s)${assignmentMsg}${fieldsMsg}.`,
    );
  });

const pullCommand: CommandModule<object, PullArguments> = {
  command: "pull [projectId]",
  describe: `Pull pipeline and step definitions from the server into ${PIPELINE_BUILDER_DIR}`,
  builder: (argv: Argv<object>) =>
    argv
      .positional("projectId", {
        describe:
          "The project to pull pipelines from (defaults to the id in .boboddy/boboddy.jsonc)",
        type: "string",
      })
      .option("baseUrl", {
        alias: "base-url",
        type: "string",
        describe: "Boboddy app base URL",
      }),
  handler: runPull,
};

// parent

export const pipelinesCommand: CommandModule<object, object> = {
  command: "pipelines <command>",
  describe: "Manage pipeline definitions",
  builder: (argv) =>
    argv
      .command(initCommand)
      .command(designCommand)
      .command(studioCommand)
      .command(pushCommand)
      .command(pullCommand)
      .demandCommand(1, "A pipelines command is required."),
  handler: () => undefined,
};
