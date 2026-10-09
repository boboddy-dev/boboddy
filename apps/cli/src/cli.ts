/**
 * The CLI's command tree and top-level runner, kept apart from `index.ts` so
 * tests can drive `run()` without the entrypoint's `process.exit`.
 */
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";
import { CoreError } from "@boboddy/worker";

import { authCommand } from "./commands/auth";
import { executionCommand } from "./commands/execution";
import { helloCommand } from "./commands/hello";
import { initCommand } from "./commands/init";
import { reportBugCommand } from "./commands/report-bug";
import { runtimeCommand } from "./commands/runtime";
import { pipelinesCommand } from "./commands/pipelines";
import { telemetryCommand } from "./commands/telemetry";
import { workCommand } from "./commands/work";
import { createCliLogger } from "./lib/logger";
import { AnalyticsEvents } from "@boboddy/observability/analytics/events";
import { classifyCliError } from "./lib/cli-error";
import { captureMilestone, flushTelemetry } from "./lib/telemetry";
import { version as CLI_VERSION } from "../package.json";
const logger = createCliLogger("cli");

/**
 * The command tree. `onCommand` receives the resolved command path (e.g.
 * `"pipelines design"`) before its handler runs, so a failure can be
 * attributed to it.
 */
export function createCli(
  argv: readonly string[],
  onCommand: (command: string) => void = () => undefined,
) {
  return yargs(argv)
    .scriptName("boboddy")
    .strict()
    .help()
    .version(CLI_VERSION)
    .fail((message, error) => {
      if (error instanceof Error) {
        throw error;
      }

      throw new Error(message);
    })
    .showHelpOnFail(false)
    .exitProcess(false)
    .option("envFile", {
      alias: "env-file",
      describe: "Path to an env file to load (defaults to .env)",
      type: "string",
      global: true,
    })
    .option("verbose", {
      alias: "v",
      describe: "Show full diagnostic logs alongside the UI",
      type: "boolean",
      default: false,
      global: true,
    })
    .middleware((arguments_) => {
      onCommand(arguments_._.map(String).join(" "));
      dotenv.config({ path: arguments_.envFile ?? ".env", override: false });
      dotenv.config({ path: ".boboddy.env", override: false });
    })
    .command(authCommand)
    .command(executionCommand)
    .command(helloCommand)
    .command(initCommand)
    .command(reportBugCommand)
    .command(runtimeCommand)
    .command(pipelinesCommand)
    .command(telemetryCommand)
    .command(workCommand)
    .demandCommand(1, "A command is required.");
}

export async function run(
  argv: readonly string[] = hideBin(process.argv),
): Promise<number> {
  let command = "unknown";
  try {
    await createCli(argv, (resolved) => {
      command = resolved;
    }).parseAsync();
    return 0;
  } catch (error) {
    captureMilestone(AnalyticsEvents.CliCommandFailed, {
      command,
      code: classifyCliError(error),
    });

    if (error instanceof CoreError) {
      logger.error(error.message);
    } else if (error instanceof Error) {
      logger.error({ err: error }, error.message);
    } else {
      logger.error({ error }, "Unknown CLI error.");
    }

    return 1;
  } finally {
    // Bounded: never lets telemetry delay process exit by more than its own
    // timeout, whether the command above succeeded or threw.
    await flushTelemetry();
  }
}
