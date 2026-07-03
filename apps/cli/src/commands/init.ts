import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { createInterface } from "node:readline/promises";
import {
  analyzeRepo,
  globalSetup,
  localConfigSetup,
  recommendPipelines,
  requireDevcontainer,
  resolveBoboddyBaseUrl,
  verifyRequirements,
} from "@boboddy/worker";

async function promptForConfirmation(question: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await readline.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

async function promptForAppAccessInstructions(): Promise<string | null> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      const answer = (
        await readline.question(
          "Application access instructions (type 'skip' to skip setup): ",
        )
      ).trim();
      if (answer.toLowerCase() === "skip") {
        return null;
      }
      if (answer.length > 0) {
        return answer;
      }
    }
  } finally {
    readline.close();
  }
}

async function runInit(
  argv: ArgumentsCamelCase<{ baseUrl?: string }>,
): Promise<void> {
  const baseUrl = resolveBoboddyBaseUrl(argv.baseUrl);
  const { headers, client } = await verifyRequirements({ baseUrl });
  await globalSetup();
  const result = await localConfigSetup({ headers, client });
  if (result) {
    const interactive = process.stdin.isTTY && process.stdout.isTTY;

    await requireDevcontainer(process.cwd());

    const analysis = await analyzeRepo();
    const accepted =
      interactive && analysis.kind === "web_app"
        ? await promptForConfirmation("Create it now? [Y/n/skip] ")
        : false;
    const appAccessInstructions =
      accepted ? await promptForAppAccessInstructions() : null;

    await recommendPipelines({
      baseUrl,
      client,
      headers,
      projectId: result.projectId,
      accepted,
      appAccessInstructions,
    });
  }
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
