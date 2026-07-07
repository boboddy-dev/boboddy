import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { RuntimeNetworkGarbageCollector } from "@boboddy/worker";
import { withReporter } from "../lib/command-output";

type CleanupNetworksArguments = {
  verbose: boolean;
};

async function cleanupNetworksHandler(
  arguments_: ArgumentsCamelCase<CleanupNetworksArguments>,
): Promise<void> {
  await withReporter(
    "runtime-cleanup-networks-command",
    async ({ reporter, logger }) => {
      const task = reporter.startTask("Cleaning up runtime networks…");
      const collector = new RuntimeNetworkGarbageCollector();
      const result = await collector.cleanupUnusedNetworks();

      task.succeed(
        `Removed ${String(result.removedCount)}, kept ${String(
          result.keptCount,
        )} of ${String(result.scannedCount)}`,
      );

      logger.info(
        {
          scannedCount: result.scannedCount,
          removedCount: result.removedCount,
          keptCount: result.keptCount,
          ...(arguments_.verbose
            ? {
                removedNetworks: result.removedNetworks,
                keptNetworks: result.keptNetworks,
              }
            : {}),
        },
        "Runtime network cleanup complete",
      );
    },
  );
}

const cleanupNetworksCommand: CommandModule<object, CleanupNetworksArguments> =
  {
    command: "cleanup-networks",
    describe: "Remove unused Boboddy runtime Docker networks",
    builder: (argv: Argv<object>) =>
      argv.option("verbose", {
        alias: "v",
        describe: "Include kept and removed network names in the output",
        type: "boolean",
        default: false,
      }),
    handler: cleanupNetworksHandler,
  };

export const runtimeCommand: CommandModule<object, object> = {
  command: "runtime <command>",
  describe: "Inspect or clean up local runtime artifacts",
  builder: (argv: Argv<object>) =>
    argv.command(cleanupNetworksCommand).demandCommand(1),
  handler: () => {},
};
