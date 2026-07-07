import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import * as clack from "@clack/prompts";
import {
  analyzeRepo,
  globalSetup,
  localConfigSetup,
  recommendPipelines,
  requireDevcontainer,
  resolveBoboddyBaseUrl,
  verifyRequirements,
} from "@boboddy/worker";
import { withReporter } from "../lib/command-output";

async function promptForConfirmation(question: string): Promise<boolean> {
  const answer = await clack.confirm({ message: question, initialValue: true });
  if (clack.isCancel(answer)) {
    throw new Error("Initialization cancelled.");
  }
  return answer;
}

async function promptForAppAccessInstructions(): Promise<string | null> {
  const answer = await clack.text({
    message: "Application access instructions (leave blank or 'skip' to skip setup):",
  });
  if (clack.isCancel(answer)) {
    throw new Error("Initialization cancelled.");
  }
  const trimmed = answer.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "skip") {
    return null;
  }
  return trimmed;
}

function runInit(
  argv: ArgumentsCamelCase<{ baseUrl?: string }>,
): Promise<void> {
  return withReporter("init", async ({ reporter }) => {
    const baseUrl = resolveBoboddyBaseUrl(argv.baseUrl);

    const t1 = reporter.startTask("Verifying requirements…");
    let verified;
    try {
      verified = await verifyRequirements({ baseUrl });
    } catch (error) {
      t1.fail("Requirements check failed");
      throw error;
    }
    t1.succeed("Requirements verified");
    const { headers, client } = verified;

    const t2 = reporter.startTask("Global setup…");
    await globalSetup();
    t2.succeed("Global setup complete");

    const t3 = reporter.startTask("Configuring project…");
    const result = await localConfigSetup({ headers, client });
    t3.succeed("Project configured");

    if (!result) return;

    const interactive = process.stdin.isTTY && process.stdout.isTTY;

    const t4 = reporter.startTask("Checking devcontainer…");
    try {
      await requireDevcontainer(process.cwd());
    } catch (error) {
      t4.fail("Devcontainer check failed");
      throw error;
    }
    t4.succeed("Devcontainer ready");

    const t5 = reporter.startTask("Analyzing repository…");
    const analysis = await analyzeRepo();
    t5.succeed("Repository analyzed");

    const accepted =
      interactive && analysis.kind === "web_app"
        ? await promptForConfirmation("Create it now?")
        : false;
    const appAccessInstructions = accepted
      ? await promptForAppAccessInstructions()
      : null;

    const t6 = reporter.startTask("Recommending pipelines…");
    await recommendPipelines({
      baseUrl,
      client,
      headers,
      projectId: result.projectId,
      accepted,
      appAccessInstructions,
    });
    t6.succeed("Pipelines recommended");
  });
}

const addBaseUrlOption = (argv: Argv<object>) =>
  argv.option("base-url", {
    type: "string",
    describe: "Boboddy app base URL",
  });

export const initCommand: CommandModule = {
  command: "init",
  describe: "Initialize boboddy globally and for the current project",
  builder: addBaseUrlOption,
  handler: runInit,
};
