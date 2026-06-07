import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  listExistingPipelineBuilderFiles,
  loadAuthenticatedSession,
  PIPELINE_BUILDER_DIR,
  pullPipelineDefinitions,
  readProjectConfig,
  resolveBoboddyBaseUrl,
  scaffoldPipelineBuilderDirectory,
  type StepInfo,
} from "@boboddy/worker";
import { version as CLI_VERSION } from "../../package.json";
import { detectPipelineRuntime } from "../lib/detect-pipeline-runtime";
import { createCliLogger } from "../lib/logger";
import {
  PUSH_SCRIPT_FILENAME,
  PUSH_SCRIPT_TEMPLATE,
} from "../templates/push-script";

const DUMMY_STEPS: StepInfo[] = [
  {
    key: "investigate",
    name: "Investigate",
    version: 1,
    prompt:
      "You are an expert investigator. Analyze the provided content thoroughly to identify the root cause, assess the severity, and recommend next steps.",
    signals: [{ key: "confidence", sourcePath: "confidence", type: "number" }],
  },
];

// init

const runInit = async (): Promise<void> => {
  const logger = createCliLogger("pipelines-init");

  if (!existsSync(join(process.cwd(), ".git"))) {
    logger.error(
      "`boboddy pipelines init` must be run from the root of a git repository. Navigate to your repo root and try again.",
    );
    process.exit(1);
  }

  const dir = join(process.cwd(), PIPELINE_BUILDER_DIR);
  const result = scaffoldPipelineBuilderDirectory(dir, DUMMY_STEPS, CLI_VERSION);

  for (const file of result.created) {
    logger.info({ file }, `Created ${file}`);
  }
  for (const file of result.skipped) {
    logger.warn({ file }, `Skipped ${file} (already exists)`);
  }

  logger.info(
    { dir },
    `Pipeline builder scaffolded at ${PIPELINE_BUILDER_DIR}. Run \`npm install\` or \`bun install\` to get started.`,
  );
};

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

const runPush = async (
  args: ArgumentsCamelCase<PushArguments>,
): Promise<void> => {
  const logger = createCliLogger("pipelines-push");
  const baseUrl = resolveBoboddyBaseUrl(args.baseUrl);

  const projectId = args.projectId ?? (await readProjectConfig())?.projectId;
  if (!projectId) {
    logger.error(
      "No project ID provided. Pass one as an argument or run `boboddy init` first.",
    );
    process.exit(1);
  }

  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new Error(
      `Not signed in to ${baseUrl}. Run \`boboddy auth login\` first.`,
    );
  }

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

  const exitCode = await new Promise<number>((resolvePromise) => {
    const child = spawn(runtime.command, [...runtime.args, PUSH_SCRIPT_FILENAME], {
      cwd: dir,
      stdio: "inherit",
      env,
    });
    child.on("error", (err) => {
      logger.error({ err }, `Failed to start ${runtime.command}.`);
      resolvePromise(1);
    });
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
};

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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const list = files.map((f) => `  - ${f}`).join("\n");
    rl.question(
      `The following files will be overwritten:\n${list}\n\nContinue? (Y/n) `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() !== "n");
      },
    );
  });
}

interface PullArguments {
  projectId: string | undefined;
  baseUrl: string | undefined;
}

const runPull = async (args: ArgumentsCamelCase<PullArguments>): Promise<void> => {
  const logger = createCliLogger("pipelines-pull");
  const baseUrl = resolveBoboddyBaseUrl(args.baseUrl);

  const projectId = args.projectId ?? (await readProjectConfig())?.projectId;
  if (!projectId) {
    logger.error(
      "No project ID provided. Pass one as an argument or run `boboddy init` first.",
    );
    process.exit(1);
  }

  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new Error(`Not signed in to ${baseUrl}. Run \`boboddy auth login\` first.`);
  }

  const headers = { Authorization: `Bearer ${authenticated.profile.accessToken}` };
  const dir = join(process.cwd(), PIPELINE_BUILDER_DIR);

  const existingFiles = listExistingPipelineBuilderFiles(dir);
  const confirmed = await confirmOverwrite(existingFiles);
  if (!confirmed) {
    logger.info({}, "Pull cancelled.");
    return;
  }

  const result = await pullPipelineDefinitions({ projectId, baseUrl, headers, logger, dir, sdkVersion: CLI_VERSION });

  if (result.stepFiles === 0 && result.pipelineFiles === 0 && !result.defaultPipelineAssignmentFile) return;

  const freshlyScaffolded = existingFiles.length === 0;
  if (freshlyScaffolded) {
    logger.info(
      { dir },
      `Run \`npm install\` or \`bun install\` inside ${PIPELINE_BUILDER_DIR} to install dependencies.`,
    );
  }

  const assignmentMsg = result.defaultPipelineAssignmentFile
    ? ", default-pipeline-assignment.ts"
    : "";
  logger.info(
    { pipelineFiles: result.pipelineFiles, stepFiles: result.stepFiles, defaultPipelineAssignmentFile: result.defaultPipelineAssignmentFile },
    `Pull complete. ${String(result.pipelineFiles)} pipeline file(s), ${String(result.stepFiles)} step file(s)${assignmentMsg}.`,
  );
};

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
      .command(pushCommand)
      .command(pullCommand)
      .demandCommand(1, "A pipelines command is required."),
  handler: () => undefined,
};
