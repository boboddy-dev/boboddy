import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import * as clack from "@clack/prompts";
import { AnalyticsEvents } from "@boboddy/observability/analytics/events";
import {
  assertInteractiveTerminal,
  checkOpencodeProviderCredentials,
  completeProjectHandoff,
  hasDevcontainer,
  hasFailedExitCode,
  launchOpencodeAuthLogin,
  localConfigSetup,
  resolveBoboddyBaseUrl,
  resolveGitRepository,
  verifyRequirements,
} from "@boboddy/worker";
import { openBrowser } from "../auth/browser";
import { buildProjectsNewUrl } from "../lib/build-projects-new-url";
import { withReporter } from "../lib/command-output";
import { ensureDesignRuntime } from "../lib/design-runtime";
import { reportDevcontainerStatus } from "../lib/init-devcontainer-notice";
import { runInitHandoff, type InitHandoffPorts } from "../lib/init-handoff";
import {
  ensureOpencodeAuth,
  type InitOpencodeAuthPorts,
} from "../lib/init-opencode-auth";
import {
  HANDOFF_KEYPRESS_PROMPT,
  runProjectHandoff,
} from "../lib/init-project-handoff";
import { reportResolvedRepository } from "../lib/init-repository-resolution";
import { captureMilestone, syncIdentityFromDisk } from "../lib/telemetry";
import { waitForKeypress } from "../lib/wait-for-keypress";
import { runPipelineDesign } from "./pipelines-design";
import type { BaseReporter } from "../lib/reporter-types";

/**
 * `boboddy init` — everything a repository needs before pipelines exist:
 * requirements, global config, and the project record in
 * `.boboddy/boboddy.jsonc`. It writes no analysis of the repository: the
 * pipeline designer orients itself by reading the repository directly.
 *
 * The very first thing it does — before auth or project-matching — is
 * resolve the real repo root and `origin` remote by walking up from the
 * current directory, and print both. This makes `init` work from any
 * subdirectory of a repo (including inside a submodule), and means that walk
 * is never silent. See `lib/init-repository-resolution.ts` and
 * `resolveGitRepository` in `@boboddy/worker`.
 *
 * The OpenCode-auth gate — an `auth.json` entry or a recognized provider env
 * var, the same detection `pipelines design`'s preflight uses — HEALS itself
 * rather than hard-stopping: with nothing found, it provisions the runtime and
 * runs `opencode auth login` inline, in place. See `lib/init-opencode-auth.ts`.
 *
 * When project-matching finds no project for the resolved repo, `init` hands
 * off to the browser at `/projects/new` (pre-filled from the resolved repo)
 * instead of silently auto-creating one — see `lib/init-project-handoff.ts`
 * and #141.
 *
 * A missing devcontainer is reported, not enforced — see
 * `lib/init-devcontainer-notice.ts`. Nothing here can fail on account of it,
 * because the handoff below is what fixes it.
 *
 * It deliberately does NOT create any pipeline. Authoring happens in exactly
 * one place — `boboddy pipelines design` — which this command hands over to.
 * An optional `--work-item-id` is carried straight through to that handoff
 * (see `buildDesignerHandoffPorts`) rather than discarded, for the same
 * reason `pipelines design` accepts it directly: onboarding may already have
 * a work item in hand by the time it reaches this epilogue.
 */

async function promptToLaunchDesigner(): Promise<boolean> {
  const answer = await clack.confirm({
    message: "Design your first pipeline now?",
    initialValue: true,
  });
  // Cancelling the epilogue is not a failed init: everything is already done.
  return !clack.isCancel(answer) && answer;
}

/**
 * Wire the handoff's ports, carrying `--work-item-id` through to the designer
 * instead of discarding it. Separated from `runInit` purely so the wiring
 * itself — which argument goes where — is unit-testable without spawning a
 * real designer session.
 */
export function buildDesignerHandoffPorts(input: {
  baseUrl: string | undefined;
  workItemId: string | undefined;
  confirmLaunch: () => Promise<boolean>;
  launchDesign: (args: {
    projectId: string | undefined;
    baseUrl: string | undefined;
    workItemId: string | undefined;
  }) => Promise<void>;
}): InitHandoffPorts {
  return {
    confirmLaunch: input.confirmLaunch,
    launchDesign: () =>
      input.launchDesign({
        projectId: undefined,
        baseUrl: input.baseUrl,
        workItemId: input.workItemId,
      }),
  };
}

/** Wire the OpenCode-auth gate's ports to their real implementations. */
function buildOpencodeAuthPorts(reporter: BaseReporter): InitOpencodeAuthPorts {
  return {
    checkCredentials: () => checkOpencodeProviderCredentials({}),
    ensureRuntime: () => ensureDesignRuntime({ reporter }),
    runAuthLogin: async (launcherPath) => {
      // `opencode auth login` prompts on the tty; without one there is
      // nothing to attach to.
      assertInteractiveTerminal();
      const result = await launchOpencodeAuthLogin({
        launcherPath,
        cwd: process.cwd(),
      });
      if (hasFailedExitCode(result)) {
        throw new Error(
          `\`opencode auth login\` exited with code ${String(result.exitCode)}. ` +
            "Run `boboddy init` again once you have signed in.",
        );
      }
    },
  };
}

function runInit(
  argv: ArgumentsCamelCase<{ baseUrl?: string; workItemId?: string }>,
): Promise<void> {
  return withReporter("init", async ({ reporter }) => {
    const baseUrl = resolveBoboddyBaseUrl(argv.baseUrl);
    const interactive = process.stdin.isTTY && process.stdout.isTTY;

    // A signed-in session from an earlier run gives every milestone below
    // the real userId instead of a fresh anonymous id — see
    // `syncIdentityFromDisk`.
    syncIdentityFromDisk(baseUrl);
    captureMilestone(AnalyticsEvents.CliInitStarted);

    // Resolve the real repo root and remote before anything else — including
    // auth — so a subdirectory (or submodule) walk is never silent. See #140.
    await reportResolvedRepository({
      reporter,
      ports: { resolveGitRepository: () => resolveGitRepository() },
    });

    const t1 = reporter.startTask("Verifying requirements…");
    let verified;
    try {
      verified = await verifyRequirements({ baseUrl });
    } catch (error) {
      t1.fail("Requirements check failed");
      throw error;
    }
    t1.succeed("Requirements verified");
    captureMilestone(AnalyticsEvents.CliRequirementsVerified);
    const { headers, client } = verified;

    await ensureOpencodeAuth({
      reporter,
      ports: buildOpencodeAuthPorts(reporter),
    });

    const t3 = reporter.startTask("Configuring project…");
    // The remaining steps are idempotent either way, so a re-run still checks
    // the devcontainer and offers the handoff instead of exiting silently.
    const setupResult = await localConfigSetup({ headers, client });
    if (setupResult.status === "handoff-required") {
      t3.succeed("No matching project found");

      // Replaces the old silent `POST /projects` auto-create: send the user
      // to the browser so the GitHub-linking choice is actually seen. v1 is
      // manual — open, print instructions, block on Enter — see #141.
      const url = buildProjectsNewUrl({
        baseUrl,
        gitUrl: setupResult.gitUrl,
        suggestedName: setupResult.suggestedName,
      });
      await runProjectHandoff({
        interactive,
        reporter,
        url,
        ports: {
          openBrowser,
          waitForKeypress: () => waitForKeypress(HANDOFF_KEYPRESS_PROMPT),
          completeHandoff: () =>
            completeProjectHandoff({
              client,
              headers,
              gitUrl: setupResult.gitUrl,
            }),
        },
      });
      captureMilestone(AnalyticsEvents.CliProjectLinked, { linked: "new" });
    } else {
      t3.succeed("Project configured");
      captureMilestone(AnalyticsEvents.CliProjectLinked, {
        linked: "existing",
      });
    }

    await reportDevcontainerStatus({
      reporter,
      ports: { hasDevcontainer: () => hasDevcontainer(process.cwd()) },
    });

    await runInitHandoff({
      interactive,
      reporter,
      ports: buildDesignerHandoffPorts({
        baseUrl: argv.baseUrl,
        workItemId: argv.workItemId,
        confirmLaunch: promptToLaunchDesigner,
        launchDesign: runPipelineDesign,
      }),
    });
  });
}

const addInitOptions = (argv: Argv<object>) =>
  argv
    .option("base-url", {
      type: "string",
      describe: "Boboddy app base URL",
    })
    .option("workItemId", {
      alias: "work-item-id",
      type: "string",
      describe:
        "Carry this work item ID into the designer handoff, instead of " +
        "letting it pick from the project's recent items",
    });

export const initCommand: CommandModule = {
  command: "init",
  describe: "Initialize boboddy globally and for the current project",
  builder: addInitOptions,
  handler: runInit,
};
