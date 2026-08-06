import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import * as clack from "@clack/prompts";
import {
  globalSetup,
  hasDevcontainer,
  localConfigSetup,
  resolveBoboddyBaseUrl,
  verifyRequirements,
} from "@boboddy/worker";
import { withReporter } from "../lib/command-output";
import { reportDevcontainerStatus } from "../lib/init-devcontainer-notice";
import { runInitHandoff } from "../lib/init-handoff";
import { runPipelineDesign } from "./pipelines-design";

/**
 * `boboddy init` — everything a repository needs before pipelines exist:
 * requirements, global config, and the project record in
 * `.boboddy/boboddy.jsonc`. It writes no analysis of the repository: the
 * pipeline designer orients itself by reading the repository directly.
 *
 * A missing devcontainer is reported, not enforced — see
 * `lib/init-devcontainer-notice.ts`. Nothing here can fail on account of it,
 * because the handoff below is what fixes it.
 *
 * It deliberately does NOT create any pipeline. Authoring happens in exactly
 * one place — `boboddy pipelines design` — which this command hands over to.
 */

async function promptToLaunchDesigner(): Promise<boolean> {
  const answer = await clack.confirm({
    message: "Design your first pipeline now?",
    initialValue: true,
  });
  // Cancelling the epilogue is not a failed init: everything is already done.
  return !clack.isCancel(answer) && answer;
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
    // Returns null when the project is already configured; the remaining steps
    // are idempotent, so a re-run still checks the devcontainer and offers the
    // handoff instead of exiting silently.
    await localConfigSetup({ headers, client });
    t3.succeed("Project configured");

    await reportDevcontainerStatus({
      reporter,
      ports: { hasDevcontainer: () => hasDevcontainer(process.cwd()) },
    });

    await runInitHandoff({
      interactive: process.stdin.isTTY && process.stdout.isTTY,
      reporter,
      ports: {
        confirmLaunch: promptToLaunchDesigner,
        launchDesign: () =>
          runPipelineDesign({ projectId: undefined, baseUrl: argv.baseUrl }),
      },
    });
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
