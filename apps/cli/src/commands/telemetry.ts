import type { CommandModule } from "yargs";
import { isTelemetryDisabled, setTelemetryDisabled } from "@boboddy/worker";
import { withReporter } from "../lib/command-output";
import {
  POSTHOG_KEY_ENV_VAR,
  TELEMETRY_DEBUG_ENV_VAR,
  TELEMETRY_DISABLED_ENV_VAR,
  isTelemetryEnabled,
  telemetryKeySource,
  type TelemetryKeySource,
} from "../lib/telemetry";
import { version as CLI_VERSION } from "../../package.json";

/**
 * `boboddy telemetry` — the documented opt-out surface for #147's CLI
 * onboarding-funnel reporting. `BOBODDY_TELEMETRY_DISABLED=1` does the same
 * thing for a single invocation without touching `~/.boboddy/config.jsonc`; this
 * command is for turning it off (or back on) for every future invocation.
 */

export const KEY_SOURCE_BAKED_MESSAGE =
  "This build reports with its built-in key.";
export const KEY_SOURCE_ENV_MESSAGE = `Reporting with the ${POSTHOG_KEY_ENV_VAR} override.`;
export const KEY_SOURCE_NONE_MESSAGE =
  "This build has no reporting key, so nothing is sent even while telemetry is enabled.";

const KEY_SOURCE_MESSAGES: Record<TelemetryKeySource, string> = {
  baked: KEY_SOURCE_BAKED_MESSAGE,
  env: KEY_SOURCE_ENV_MESSAGE,
  none: KEY_SOURCE_NONE_MESSAGE,
};

/** The `telemetry status --json` line. Never includes the key itself. */
export type TelemetryStatusJson = {
  enabled: boolean;
  keySource: TelemetryKeySource;
  version: string;
};

type StatusArgs = { json?: boolean };

const runStatus = async (args: StatusArgs): Promise<void> => {
  if (args.json) {
    const status: TelemetryStatusJson = {
      enabled: isTelemetryEnabled(),
      keySource: telemetryKeySource(),
      version: CLI_VERSION,
    };
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }

  await withReporter("telemetry", ({ reporter }) => {
    if (process.env[TELEMETRY_DISABLED_ENV_VAR] === "1") {
      reporter.info(
        `Telemetry is disabled for this invocation via ${TELEMETRY_DISABLED_ENV_VAR}=1.`,
      );
    } else {
      reporter.info(
        isTelemetryDisabled()
          ? "Telemetry is disabled."
          : "Telemetry is enabled.",
      );
    }
    reporter.info(KEY_SOURCE_MESSAGES[telemetryKeySource()]);
  });
};

const runDisable = (): Promise<void> =>
  withReporter("telemetry", ({ reporter }) => {
    setTelemetryDisabled(true);
    reporter.success("Telemetry disabled.");
  });

const runEnable = (): Promise<void> =>
  withReporter("telemetry", ({ reporter }) => {
    setTelemetryDisabled(false);
    reporter.success("Telemetry enabled.");
  });

const statusCommand: CommandModule<object, StatusArgs> = {
  command: "status",
  describe: "Show whether CLI telemetry is enabled and where its key comes from",
  builder: (argv) =>
    argv.option("json", {
      describe: "Print one JSON line to stdout: enabled, keySource, version",
      type: "boolean",
      default: false,
    }),
  handler: runStatus,
};

const disableCommand: CommandModule<object, object> = {
  command: "disable",
  describe: "Turn off CLI telemetry for every future invocation",
  handler: runDisable,
};

const enableCommand: CommandModule<object, object> = {
  command: "enable",
  describe: "Turn CLI telemetry back on",
  handler: runEnable,
};

export const telemetryCommand: CommandModule<object, object> = {
  command: "telemetry <command>",
  describe: `Manage CLI telemetry (see also ${TELEMETRY_DISABLED_ENV_VAR} and ${TELEMETRY_DEBUG_ENV_VAR})`,
  builder: (argv) =>
    argv
      .command(statusCommand)
      .command(disableCommand)
      .command(enableCommand)
      .demandCommand(1, "A telemetry command is required."),
  handler: () => undefined,
};
