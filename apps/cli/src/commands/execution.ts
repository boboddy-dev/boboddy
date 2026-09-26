import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  investigateExecution,
  type InvestigateExecutionClient,
} from "@boboddy/platform-client";
import { resolveBoboddyBaseUrl } from "@boboddy/worker";
import { connectApi } from "../lib/cli-api-client";
import { withReporter } from "../lib/command-output";
import { createExecutionLogArtifactWriter } from "../lib/execution-log-cache";

/**
 * Mirrors `@boboddy/platform-client`'s `StepExecutionLogStream` (imported as a
 * type only there — see `packages/platform-client/src/lib/api-types.ts`).
 * Duplicated here as a runtime array so `--log-stream` can validate/describe
 * its choices without `@boboddy/platform-client` needing to export a value
 * for CLI-only concerns.
 */
const LOG_STREAM_VALUES = ["worker", "ai-server", "conversation"] as const;
type LogStreamValue = (typeof LOG_STREAM_VALUES)[number];

function isLogStreamValue(value: string): value is LogStreamValue {
  return (LOG_STREAM_VALUES as readonly string[]).includes(value);
}

// view

interface ViewArguments {
  executionId: string;
  attempt: number | undefined;
  step: string | undefined;
  log: boolean;
  logStream: string | undefined;
  artifacts: boolean;
  baseUrl: string | undefined;
}

const runView = (args: ArgumentsCamelCase<ViewArguments>): Promise<void> =>
  withReporter("execution-view", async () => {
    if (args.logStream !== undefined && !isLogStreamValue(args.logStream)) {
      throw new Error(
        `Invalid --log-stream "${args.logStream}". Expected one of: ${LOG_STREAM_VALUES.join(", ")}.`,
      );
    }

    const baseUrl = resolveBoboddyBaseUrl(args.baseUrl);
    const api = await connectApi(baseUrl);

    const output = await investigateExecution({
      // `@hey-api/openapi-ts` encodes every nullable field on the generated
      // `BoboddyClient` as `T | unknown` (collapsing to `unknown` — the same
      // quirk `packages/platform-client/src/lib/api-types.ts` documents for
      // why that package defines its own nullable-correct types instead of
      // importing the generated ones). That makes the generated client's
      // method return types structurally incompatible with
      // `InvestigateExecutionClient`'s (correctly-nullable) parameter types,
      // even though the real runtime values match at every field. Asserted
      // here rather than in `platform-client` itself, which only defines the
      // interface and never receives (so never has to convert) a real
      // `BoboddyClient`.
      client: api.client as unknown as InvestigateExecutionClient,
      headers: api.headers,
      executionId: args.executionId,
      attempt: args.attempt,
      step: args.step,
      // A stream pick with no --log is unambiguously asking to see that
      // stream's logs, so --log-stream implies --log (documented on the flag
      // below).
      log: args.log || args.logStream !== undefined,
      logStream: args.logStream,
      artifacts: args.artifacts,
      writeLogArtifact: createExecutionLogArtifactWriter(),
    });

    process.stdout.write(`${output}\n`);
  });

const viewCommand: CommandModule<object, ViewArguments> = {
  command: "view <executionId>",
  describe: "Investigate a single pipeline execution",
  builder: (argv: Argv<object>) =>
    argv
      .positional("executionId", {
        describe: "The pipeline execution ID to investigate",
        type: "string",
        demandOption: true,
      })
      .option("attempt", {
        describe: "Attempt number to investigate (defaults to the latest)",
        type: "number",
      })
      .option("step", {
        describe:
          "Step key to drill into: status, signals, output, and evaluation",
        type: "string",
      })
      .option("log", {
        describe: "Fetch and render this step's logs",
        type: "boolean",
        default: false,
      })
      .option("logStream", {
        alias: "log-stream",
        describe:
          `Narrow --log to one stream (${LOG_STREAM_VALUES.join(" | ")}); ` +
          "implies --log. Defaults to all three streams.",
        type: "string",
      })
      .option("artifacts", {
        describe: "List this step's artifacts with presigned download URLs",
        type: "boolean",
        default: false,
      })
      .option("baseUrl", {
        alias: "base-url",
        describe: "Boboddy app base URL",
        type: "string",
      }),
  handler: runView,
};

// parent

export const executionCommand: CommandModule<object, object> = {
  command: "execution <command>",
  describe: "Investigate a pipeline execution",
  builder: (argv) =>
    argv
      .command(viewCommand)
      .demandCommand(1, "An execution command is required."),
  handler: () => undefined,
};
