import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import dotenv from "dotenv";
import { CoreError } from "@boboddy/worker";

import { authCommand } from "./commands/auth";
import { helloCommand } from "./commands/hello";
import { initCommand } from "./commands/init";
import { proxyCommand } from "./commands/proxy";
import { reportBugCommand } from "./commands/report-bug";
import { runtimeCommand } from "./commands/runtime";
import { pipelinesCommand } from "./commands/pipelines";
import { workCommand } from "./commands/work";
import { createCliLogger } from "./lib/logger";
import { version as CLI_VERSION } from "../package.json";
const logger = createCliLogger("cli");

export function createCli(argv: readonly string[]) {
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
    .middleware((arguments_) => {
      dotenv.config({ path: arguments_.envFile ?? ".env", override: false });
      dotenv.config({ path: ".boboddy.env", override: false });
    })
    .command(authCommand)
    .command(helloCommand)
    .command(initCommand)
    .command(proxyCommand)
    .command(reportBugCommand)
    .command(runtimeCommand)
    .command(pipelinesCommand)
    .command(workCommand)
    .demandCommand(1, "A command is required.");
}

export async function run(argv: readonly string[] = hideBin(process.argv)): Promise<number> {
  try {
    await createCli(argv).parseAsync();
    return 0;
  } catch (error) {
    if (error instanceof CoreError) {
      logger.error(error.message);
    } else if (error instanceof Error) {
      logger.error({ err: error }, error.message);
    } else {
      logger.error({ error }, "Unknown CLI error.");
    }

    return 1;
  }
}

const exitCode = await run();
process.exit(exitCode);
