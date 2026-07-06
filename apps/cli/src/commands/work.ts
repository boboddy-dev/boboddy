import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import dotenv from "dotenv";
import {
  readProjectConfig,
  resolveBoboddyBaseUrl,
  runProjectWork,
} from "@boboddy/worker";
import {
  createCliLogger,
  createTransport,
  ensureLogDir,
  resolveLogFilePath,
} from "../lib/logger";
import { createReporter } from "../lib/reporter";

async function readLocalEnvVars(): Promise<Record<string, string>> {
  const envFilePath = path.join(process.cwd(), ".boboddy", ".env");
  try {
    const content = await readFile(envFilePath, "utf8");
    return dotenv.parse(content);
  } catch {
    // File is optional — absence is not an error.
    return {};
  }
}

export interface WorkArguments {
  projectId: string | undefined;
  baseUrl: string | undefined;
  batchSize: number | undefined;
  concurrency: number | undefined;
  leaseDurationSeconds: number | undefined;
  once: boolean;
  preserveRuntimeOnComplete: boolean;
  pollIntervalMs: number | undefined;
  workerId: string | undefined;
  workItemId: string | undefined;
}

async function handler(
  arguments_: ArgumentsCamelCase<WorkArguments>,
): Promise<void> {
  await ensureLogDir();
  const logFilePath = resolveLogFilePath();
  // Initialize the transport (and open the log file) before anything else logs.
  createTransport();

  const logger = createCliLogger("work-command");
  const reporter = createReporter({ logFilePath });
  const baseUrl = resolveBoboddyBaseUrl(arguments_.baseUrl);
  const projectId =
    arguments_.projectId ?? (await readProjectConfig())?.projectId;

  if (!projectId) {
    reporter.error(
      "No project ID provided. Pass one as an argument or run `boboddy init` first.",
    );
    logger.error(
      "No project ID provided. Pass one as an argument or run `boboddy init` first.",
    );
    process.exit(1);
  }

  reporter.start("Boboddy worker");

  logger.info({
    projectId,
    baseUrl,
    batchSize: arguments_.batchSize,
    concurrency: arguments_.concurrency,
    leaseDurationSeconds: arguments_.leaseDurationSeconds,
    once: arguments_.once,
    preserveRuntimeOnComplete: arguments_.preserveRuntimeOnComplete,
    pollIntervalMs: arguments_.pollIntervalMs,
    workerId: arguments_.workerId,
    workItemId: arguments_.workItemId,
  }, "Starting worker command");

  const localEnvVars = await readLocalEnvVars();
  logger.info(
    { varCount: Object.keys(localEnvVars).length, varNames: Object.keys(localEnvVars) },
    "Loaded .boboddy/.env",
  );

  try {
    const result = await runProjectWork({
      projectId,
      baseUrl,
      batchSize: arguments_.batchSize,
      concurrency: arguments_.concurrency,
      leaseDurationSeconds: arguments_.leaseDurationSeconds,
      preserveRuntimeOnComplete: arguments_.preserveRuntimeOnComplete,
      once: arguments_.once,
      pollIntervalMs: arguments_.pollIntervalMs,
      workerId: arguments_.workerId,
      workItemId: arguments_.workItemId,
      dest: createTransport(),
      localEnvVars,
      reporter,
    });

    if (arguments_.once) {
      logger.info(
        {
          projectId,
          ...result,
        },
        "Single-pass work result",
      );
    }

    reporter.finish("Done");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    reporter.error(message);
    reporter.finish("Worker stopped with errors");
    logger.error({ err: error }, "Worker command failed");
    throw error;
  }
}

export const workCommand: CommandModule<object, WorkArguments> = {
  command: "work [projectId]",
  describe: "Run the Boboddy host worker for a project",
  builder: (argv: Argv<object>) =>
    argv
      .positional("projectId", {
        describe:
          "The project id to process work for (defaults to the id in .boboddy/boboddy.jsonc)",
        type: "string",
      })
      .option("baseUrl", {
        alias: "base-url",
        describe: "Boboddy app base URL",
        type: "string",
      })
      .option("batchSize", {
        alias: "b",
        describe: "Maximum number of step executions to claim per poll",
        type: "number",
      })
      .option("concurrency", {
        alias: "c",
        describe: "Maximum number of concurrently active jobs",
        type: "number",
      })
      .option("leaseDurationSeconds", {
        alias: "l",
        describe: "How long the claim lease should last",
        type: "number",
      })
      .option("pollIntervalMs", {
        alias: "p",
        describe: "How often to poll for new step executions",
        type: "number",
      })
      .option("once", {
        describe: "Poll a single time and wait for any claimed jobs to finish",
        type: "boolean",
        default: false,
      })
      .option("preserveRuntimeOnComplete", {
        alias: "k",
        describe: "Keep runtime containers and workspace after step completion",
        type: "boolean",
        default: false,
      })
      .option("workerId", {
        alias: "w",
        describe: "Optional worker identifier to use while claiming steps",
        type: "string",
      })
      .option("workItemId", {
        alias: "work-item-id",
        describe: "Only process step executions for this work item ID",
        type: "string",
      }),
  handler,
};
