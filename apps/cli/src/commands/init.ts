import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import * as clack from "@clack/prompts";
import type { createBoboddyClient } from "@boboddy/sdk";
import { AnalyticsEvents } from "@boboddy/observability/analytics/events";
import {
  checkOpencodeProviderCredentials,
  completeProjectHandoff,
  hasDevcontainer,
  localConfigSetup,
  resolveBoboddyBaseUrl,
  resolveGitRepository,
  verifyRequirements,
} from "@boboddy/worker";
import { openBrowser } from "../auth/browser";
import { buildProjectsNewUrl } from "../lib/build-projects-new-url";
import { withReporter } from "../lib/command-output";
import { reportDevcontainerStatus } from "../lib/init-devcontainer-notice";
import { runInitHandoff, type InitHandoffPorts } from "../lib/init-handoff";
import {
  buildProjectAutocreatePorts,
  tryAutocreateGitHubProject,
  type ProjectAutocreatePorts,
} from "../lib/init-project-autocreate";
import {
  runProjectHandoff,
  type ProjectHandoffPorts,
} from "../lib/init-project-handoff";
import {
  reportResolvedRepository,
  warnAboutStrayProjectConfig,
  type ResolvedRepository,
} from "../lib/init-repository-resolution";
import { reportProviderStatus } from "../lib/init-provider-notice";
import { listenForEnter } from "../lib/listen-for-enter";
import { captureMilestone, syncIdentityFromDisk } from "../lib/telemetry";
import { runPipelineDesign } from "./pipelines-design";
import type { BaseReporter } from "../lib/reporter-types";
import { createSignInPorts, ensureSignedIn } from "../lib/ensure-signed-in";

/**
 * `boboddy init` — everything a repository needs before pipelines exist:
 * requirements, global config, and the project record in
 * `.boboddy/boboddy.jsonc`. It writes no analysis of the repository: the
 * pipeline designer orients itself by reading the repository directly.
 *
 * The very first thing it does — before auth or project-matching — is
 * resolve the real repo root and `origin` remote by walking up from the
 * current directory, and print both (with any credential stripped from the
 * remote). That root is then threaded explicitly through every step that
 * touches the filesystem — the project config, the devcontainer check, and
 * the designer — so `init` behaves the same from any subdirectory of a repo
 * (including inside a submodule). See `lib/init-repository-resolution.ts` and
 * `resolveGitRepository` in `@boboddy/worker`.
 *
 * Signing in to Boboddy heals the same way: a missing or no-longer-valid
 * session runs the device login inline in an interactive terminal, and only a
 * non-interactive one stops with "run `boboddy auth login`". See
 * `lib/ensure-signed-in.ts`.
 *
 * The AI provider is only *reported*, never required: `init` checks for an
 * `auth.json` entry or a recognized provider env var without downloading the
 * runtime, and says what it found. Connecting one is the designer's job — the
 * `pipelines design` preflight runs `opencode auth login` right before the TUI
 * launches. See `lib/init-provider-notice.ts` and
 * `lib/design-provider-connect.ts`.
 *
 * When project-matching finds no project for the resolved repo, `init` first
 * offers to create one through the API from the GitHub repo, when one of the
 * user's GitHub App installations covers it (`lib/init-project-autocreate.ts`).
 * Otherwise it opens `/projects/new` (pre-filled from the resolved repo) and
 * polls until the project exists (`lib/init-project-handoff.ts`, #141).
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

function multipleProjectsMatchMessage(
  matchCount: number,
  projectName: string,
): string {
  return `${String(matchCount)} projects match this repo; using ${projectName}.`;
}

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
  /** `--no-studio`; the studio is on unless this is `false`. */
  studio?: boolean | undefined;
  repoRoot: string;
  confirmLaunch: () => Promise<boolean>;
  launchDesign: (args: {
    projectId: string | undefined;
    baseUrl: string | undefined;
    workItemId: string | undefined;
    studio: boolean;
    repoRoot: string;
  }) => Promise<void>;
}): InitHandoffPorts {
  return {
    confirmLaunch: input.confirmLaunch,
    launchDesign: () =>
      input.launchDesign({
        projectId: undefined,
        baseUrl: input.baseUrl,
        workItemId: input.workItemId,
        studio: input.studio ?? true,
        repoRoot: input.repoRoot,
      }),
  };
}

/** The I/O of linking a repository to a project, beyond the API client. */
export interface LinkProjectPorts {
  autocreate: ProjectAutocreatePorts;
  handoff: Omit<ProjectHandoffPorts, "checkForProject">;
}

function buildLinkProjectPorts(input: {
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  repoRoot: string;
}): LinkProjectPorts {
  return {
    autocreate: buildProjectAutocreatePorts(input),
    handoff: {
      openBrowser,
      startCheckTrigger: listenForEnter,
      now: Date.now,
    },
  };
}

/**
 * Make sure `<repoRoot>/.boboddy/boboddy.jsonc` names this repository's
 * project: keep an existing config, link a matching project, or — when there
 * is none — create one through the API and fall back to the browser hand-off.
 * Exported so the whole ladder is testable against a fake client.
 */
export async function linkInitProject(input: {
  baseUrl: string;
  interactive: boolean;
  reporter: BaseReporter;
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  repo: ResolvedRepository;
  ports: LinkProjectPorts;
}): Promise<void> {
  const { baseUrl, interactive, reporter, client, headers, repo, ports } =
    input;

  const task = reporter.startTask("Configuring project…");
  // The remaining steps are idempotent either way, so a re-run still checks
  // the devcontainer and offers the handoff instead of exiting silently.
  const setupResult = await localConfigSetup({
    headers,
    client,
    rootDir: repo.repoRoot,
  });

  if (setupResult.status !== "handoff-required") {
    task.succeed("Project configured");
    if (setupResult.status === "matched" && setupResult.matchCount > 1) {
      reporter.info(
        multipleProjectsMatchMessage(
          setupResult.matchCount,
          setupResult.projectName,
        ),
      );
    }
    captureMilestone(AnalyticsEvents.CliProjectLinked, { linked: "existing" });
    return;
  }

  task.succeed("No project found for this repository yet");

  const autocreated = await tryAutocreateGitHubProject({
    interactive,
    reporter,
    baseUrl,
    remoteUrl: setupResult.gitUrl,
    suggestedName: setupResult.suggestedName,
    ports: ports.autocreate,
  });
  if (autocreated.status === "created") {
    captureMilestone(AnalyticsEvents.CliProjectLinked, {
      linked: "new",
      via: "api",
    });
    return;
  }

  await runProjectHandoff({
    interactive,
    reporter,
    url: buildProjectsNewUrl({
      baseUrl,
      gitUrl: setupResult.gitUrl,
      suggestedName: setupResult.suggestedName,
    }),
    ports: {
      ...ports.handoff,
      checkForProject: () =>
        completeProjectHandoff({
          client,
          headers,
          gitUrl: setupResult.gitUrl,
          rootDir: repo.repoRoot,
        }),
    },
  });
  captureMilestone(AnalyticsEvents.CliProjectLinked, {
    linked: "new",
    via: "browser",
  });
}

interface InitArguments {
  baseUrl?: string;
  workItemId?: string;
  studio?: boolean;
}

function runInit(argv: ArgumentsCamelCase<InitArguments>): Promise<void> {
  return withReporter("init", async ({ reporter, logger }) => {
    const baseUrl = resolveBoboddyBaseUrl(argv.baseUrl);
    const interactive = process.stdin.isTTY && process.stdout.isTTY;

    // A signed-in session from an earlier run gives every milestone below
    // the real userId instead of a fresh anonymous id — see
    // `syncIdentityFromDisk`.
    syncIdentityFromDisk(baseUrl);
    captureMilestone(AnalyticsEvents.CliInitStarted);

    // Resolve the real repo root and remote before anything else — including
    // auth — so a subdirectory (or submodule) walk is never silent. See #140.
    const repo = await reportResolvedRepository({
      reporter,
      ports: { resolveGitRepository: () => resolveGitRepository() },
    });
    warnAboutStrayProjectConfig({
      cwd: process.cwd(),
      repoRoot: repo.repoRoot,
      reporter,
    });

    await ensureSignedIn({
      baseUrl,
      interactive,
      reporter,
      ports: createSignInPorts({ reporter, logger }),
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

    await linkInitProject({
      baseUrl,
      interactive,
      reporter,
      client,
      headers,
      repo,
      ports: buildLinkProjectPorts({
        client,
        headers,
        repoRoot: repo.repoRoot,
      }),
    });

    await reportDevcontainerStatus({
      reporter,
      ports: { hasDevcontainer: () => hasDevcontainer(repo.repoRoot) },
    });

    await reportProviderStatus({
      reporter,
      ports: { checkCredentials: () => checkOpencodeProviderCredentials({}) },
    });

    await runInitHandoff({
      interactive,
      reporter,
      ports: buildDesignerHandoffPorts({
        baseUrl: argv.baseUrl,
        workItemId: argv.workItemId,
        studio: argv.studio,
        repoRoot: repo.repoRoot,
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
    })
    .option("studio", {
      type: "boolean",
      default: true,
      describe:
        "Open the live pipeline graph in your browser alongside the session (--no-studio to skip)",
    });

export const initCommand: CommandModule = {
  command: "init",
  describe: "Initialize boboddy globally and for the current project",
  builder: addInitOptions,
  handler: runInit,
};
