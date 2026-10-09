import * as clack from "@clack/prompts";
import type { createBoboddyClient } from "@boboddy/sdk";
import { parseGitHubRepo } from "@boboddy/sdk/git-url";
import { writeProjectConfig } from "@boboddy/worker";
import { describeApiError } from "./cli-api-client";
import type { BaseReporter } from "./reporter-types";

/**
 * `init`'s first attempt at creating the missing project: straight through
 * the API, without leaving the terminal.
 *
 * It applies only when the `origin` remote is a GitHub repository that one of
 * the user's own GitHub App installations covers. Then it offers to create the
 * project from that repo — the same `POST /projects/from-github` the web
 * picker uses, so issues are imported and the integration is linked — and
 * writes `.boboddy/boboddy.jsonc`. Every other outcome is a `skipped` result,
 * and `init` falls back to the browser hand-off (`init-project-handoff.ts`).
 *
 * Installations another org member made are invisible here
 * (`listMyGitHubRepos` lists only the caller's own); the browser hand-off
 * still covers that case.
 *
 * The I/O sits behind {@link ProjectAutocreatePorts} so every branch is
 * unit-testable without a terminal or a network.
 */

export interface GitHubRepoRef {
  id: number;
  fullName: string;
}

export interface GitHubInstallationRepos {
  installationId: string;
  repos: GitHubRepoRef[];
}

export type ListGitHubReposResult =
  | { status: "ok"; installations: GitHubInstallationRepos[] }
  | { status: "github-app-not-configured" }
  | { status: "failed"; reason: string };

export interface CreatedGitHubProject {
  projectId: string;
  slug: string;
  ownerUsername: string | null;
  initialSyncFailed: boolean;
}

export type CreateGitHubProjectResult =
  | { status: "created"; project: CreatedGitHubProject }
  | { status: "failed"; reason: string };

export interface ProjectAutocreatePorts {
  /** The cached repo lists of the caller's own GitHub App installations. */
  listRepos(): Promise<ListGitHubReposResult>;
  /** Re-read one installation's repos from GitHub; `undefined` if that fails. */
  refresh(installationId: string): Promise<GitHubInstallationRepos | undefined>;
  /** Ask the user a yes/no question; `false` on decline or cancel. */
  confirm(message: string): Promise<boolean>;
  create(input: {
    installationId: string;
    repo: GitHubRepoRef;
    name: string;
  }): Promise<CreateGitHubProjectResult>;
  /** Persist the new project id to `.boboddy/boboddy.jsonc` at the repo root. */
  writeConfig(projectId: string): Promise<void>;
}

export type ProjectAutocreateSkipReason =
  | "noninteractive"
  | "not-github"
  | "github-app-not-configured"
  | "github-repos-unavailable"
  | "repo-not-installed"
  | "declined"
  | "create-failed";

export type ProjectAutocreateResult =
  | { status: "created"; projectId: string }
  | { status: "skipped"; reason: ProjectAutocreateSkipReason };

export const REFRESH_TASK_LABEL = "Checking your GitHub installations…";
export const CREATE_TASK_LABEL = "Creating project and importing issues…";

export function confirmCreateMessage(name: string, fullName: string): string {
  return `Create Boboddy project “${name}” from GitHub ${fullName}?`;
}

export function initialSyncFailedMessage(settingsUrl: string): string {
  return (
    "The project was created, but importing issues from GitHub failed. " +
    `Retry the sync from the project's settings: ${settingsUrl}`
  );
}

export function projectSettingsUrl(
  baseUrl: string,
  project: CreatedGitHubProject,
): string {
  if (project.ownerUsername === null) {
    return new URL("/projects", baseUrl).toString();
  }
  const path = [project.ownerUsername, project.slug, "settings"]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(`/${path}`, baseUrl).toString();
}

function findRepo(
  installations: readonly GitHubInstallationRepos[],
  fullName: string,
): { installationId: string; repo: GitHubRepoRef } | undefined {
  const wanted = fullName.toLowerCase();
  for (const installation of installations) {
    const repo = installation.repos.find(
      (candidate) => candidate.fullName.toLowerCase() === wanted,
    );
    if (repo) {
      return { installationId: installation.installationId, repo };
    }
  }
  return undefined;
}

/**
 * Try to create the project for `remoteUrl` through the API. Never throws for
 * an expected miss — those come back as `skipped` so `init` can fall back to
 * the browser.
 */
export async function tryAutocreateGitHubProject(input: {
  interactive: boolean;
  reporter: BaseReporter;
  baseUrl: string;
  remoteUrl: string;
  suggestedName: string;
  ports: ProjectAutocreatePorts;
}): Promise<ProjectAutocreateResult> {
  const { interactive, reporter, baseUrl, remoteUrl, suggestedName, ports } =
    input;

  if (!interactive) {
    return { status: "skipped", reason: "noninteractive" };
  }

  const githubRepo = parseGitHubRepo(remoteUrl);
  if (githubRepo === null) {
    return { status: "skipped", reason: "not-github" };
  }
  const fullName = `${githubRepo.owner}/${githubRepo.name}`;

  const listed = await ports.listRepos();
  if (listed.status === "github-app-not-configured") {
    return { status: "skipped", reason: "github-app-not-configured" };
  }
  if (listed.status === "failed") {
    reporter.warn(
      `Could not list your GitHub repositories (${listed.reason}); finishing in the browser instead.`,
    );
    return { status: "skipped", reason: "github-repos-unavailable" };
  }

  let hit = findRepo(listed.installations, fullName);
  if (!hit && listed.installations.length > 0) {
    const task = reporter.startTask(REFRESH_TASK_LABEL);
    const refreshed = await Promise.all(
      listed.installations.map((installation) =>
        ports.refresh(installation.installationId),
      ),
    );
    hit = findRepo(
      refreshed.filter((installation) => installation !== undefined),
      fullName,
    );
    task.succeed(
      hit
        ? `Found ${hit.repo.fullName} in your GitHub installations`
        : `${fullName} isn't in your GitHub installations`,
    );
  }
  if (!hit) {
    return { status: "skipped", reason: "repo-not-installed" };
  }

  const accepted = await ports.confirm(
    confirmCreateMessage(suggestedName, hit.repo.fullName),
  );
  if (!accepted) {
    return { status: "skipped", reason: "declined" };
  }

  const task = reporter.startTask(CREATE_TASK_LABEL);
  const created = await ports.create({
    installationId: hit.installationId,
    repo: hit.repo,
    name: suggestedName,
  });
  if (created.status === "failed") {
    task.fail("Could not create the project");
    reporter.warn(
      `Could not create the project automatically (${created.reason}); finishing in the browser instead.`,
    );
    return { status: "skipped", reason: "create-failed" };
  }
  task.succeed(`Created project “${suggestedName}”`);

  const { project } = created;
  if (project.initialSyncFailed) {
    reporter.warn(
      initialSyncFailedMessage(projectSettingsUrl(baseUrl, project)),
    );
  }

  await ports.writeConfig(project.projectId);
  return { status: "created", projectId: project.projectId };
}

type BoboddyClient = ReturnType<typeof createBoboddyClient>;

function httpReason(
  status: number,
  error: { title?: string; detail?: string },
) {
  return `HTTP ${String(status)}: ${describeApiError(error)}`;
}

/** Wire the autocreate ports to the SDK, a `clack` confirm, and the repo root. */
export function buildProjectAutocreatePorts(input: {
  client: BoboddyClient;
  headers: { Authorization: string };
  repoRoot: string;
}): ProjectAutocreatePorts {
  const { client, headers, repoRoot } = input;
  return {
    listRepos: async () => {
      const { data, error, response } =
        await client.gitHubIntegrations.listMyGitHubRepos({ headers });
      if (error !== undefined) {
        if (error.code === "GITHUB_APP_NOT_CONFIGURED") {
          return { status: "github-app-not-configured" };
        }
        return { status: "failed", reason: httpReason(response.status, error) };
      }
      return {
        status: "ok",
        installations: data.map(({ installationId, repos }) => ({
          installationId,
          repos,
        })),
      };
    },
    refresh: async (installationId) => {
      const { data, error } =
        await client.gitHubIntegrations.refreshGitHubInstallationRepos({
          path: { installationId },
          headers,
        });
      if (error !== undefined) {
        return undefined;
      }
      return { installationId: data.installationId, repos: data.repos };
    },
    confirm: async (message) => {
      const answer = await clack.confirm({ message, initialValue: true });
      return !clack.isCancel(answer) && answer;
    },
    create: async ({ installationId, repo, name }) => {
      const { data, error, response } =
        await client.projects.createProjectFromGitHubRepo({
          body: { installationId, repo, name, origin: "cli_api" },
          headers,
        });
      if (error !== undefined) {
        return { status: "failed", reason: httpReason(response.status, error) };
      }
      return {
        status: "created",
        project: {
          projectId: data.id,
          slug: data.slug,
          ownerUsername:
            typeof data.ownerUsername === "string" ? data.ownerUsername : null,
          initialSyncFailed: data.initialSyncFailed,
        },
      };
    },
    writeConfig: (projectId) => writeProjectConfig(projectId, repoRoot),
  };
}
