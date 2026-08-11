import type { CommandModule } from "yargs";
import { isTelemetryDisabled, setTelemetryDisabled } from "@boboddy/worker";
import { withReporter } from "../lib/command-output";
import {
  TELEMETRY_DEBUG_ENV_VAR,
  TELEMETRY_DISABLED_ENV_VAR,
} from "../lib/telemetry";

/**
 * `boboddy telemetry` — the documented opt-out surface for #147's CLI
 * onboarding-funnel reporting. `BOBODDY_TELEMETRY_DISABLED=1` does the same
 * thing for a single invocation without touching `~/.boboddy.json`; this
 * command is for turning it off (or back on) for every future invocation.
 */

const runStatus = (): Promise<void> =>
  withReporter("telemetry", ({ reporter }) => {
    if (process.env[TELEMETRY_DISABLED_ENV_VAR] === "1") {
      reporter.info(
        `Telemetry is disabled for this invocation via ${TELEMETRY_DISABLED_ENV_VAR}=1.`,
      );
      return;
    }
    reporter.info(
      isTelemetryDisabled()
        ? "Telemetry is disabled."
        : "Telemetry is enabled.",
    );
  });

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

const statusCommand: CommandModule<object, object> = {
  command: "status",
  describe: "Show whether CLI telemetry is enabled",
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
