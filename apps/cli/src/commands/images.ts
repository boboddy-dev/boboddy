import type { Argv, CommandModule } from "yargs";
import { spawnSync } from "node:child_process";
import { createCliLogger } from "../lib/logger";

// pull

interface PullArgs {
  "dry-run": boolean;
  dryRun: boolean;
}

async function runPull(args: PullArgs): Promise<void> {
  const logger = createCliLogger("images-pull");

  const { resolveAiImage } = await import("@boboddy/worker/runtime/runtime-service/domain/ai-image");
  const aiImage = resolveAiImage().ref;

  if (args.dryRun) {
    logger.info({ image: aiImage }, `Would pull AI worker image: ${aiImage}`);
    console.log(aiImage);
    return;
  }

  logger.info({ image: aiImage }, `Pulling AI worker image: ${aiImage}`);

  // On Windows, GitHub Actions runners use Windows container mode by default
  // (no WSLv2 / Hyper-V). Passing --platform linux/amd64 makes Docker pull the
  // Linux manifest regardless of the host container mode, which matches what a
  // normal Windows user with Docker Desktop (WSLv2, Linux container mode) gets.
  const pullArgs =
    process.platform === "win32"
      ? ["pull", "--platform", "linux/amd64", aiImage]
      : ["pull", aiImage];

  const result = spawnSync("docker", pullArgs, { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`docker pull exited with status ${String(result.status)}`);
  }
}

const pullCommand: CommandModule<object, PullArgs> = {
  command: "pull",
  describe: "Pull the AI worker Docker image bundled with this CLI version",
  builder: (argv: Argv<object>) =>
    argv.option("dry-run", {
      alias: "d",
      type: "boolean",
      default: false,
      describe: "Show the image that would be pulled without downloading it",
    }) as Argv<PullArgs>,
  handler: runPull,
};

// parent

export const imagesCommand: CommandModule<object, object> = {
  command: "images <command>",
  describe: "Manage Boboddy Docker images",
  builder: (argv: Argv<object>) =>
    argv.command(pullCommand).demandCommand(1, "An images command is required."),
  handler: () => {},
};
