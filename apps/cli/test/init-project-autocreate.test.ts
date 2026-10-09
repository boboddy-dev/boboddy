import { describe, expect } from "bun:test";
import {
  CREATE_TASK_LABEL,
  REFRESH_TASK_LABEL,
  confirmCreateMessage,
  initialSyncFailedMessage,
  tryAutocreateGitHubProject,
  type CreateGitHubProjectResult,
  type GitHubInstallationRepos,
  type ListGitHubReposResult,
  type ProjectAutocreatePorts,
} from "../src/lib/init-project-autocreate";
import {
  concurrentTest as test,
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
} from "./utils";

/**
 * `init`'s API-first project creation: when the remote is a GitHub repo one of
 * the user's installations covers, offer to create the project without a
 * browser. Every miss must come back as `skipped` so `init` falls back to the
 * browser hand-off.
 */

const BASE_URL = "https://app.boboddy.dev";
const REMOTE = "git@github.com:Acme/My-Repo.git";
const REPO = { id: 42, fullName: "acme/my-repo" };

function fakePorts(input: {
  list?: ListGitHubReposResult;
  refreshed?: Record<string, GitHubInstallationRepos | undefined>;
  confirm?: boolean;
  create?: CreateGitHubProjectResult;
}) {
  const calls: string[] = [];
  const created: Array<Parameters<ProjectAutocreatePorts["create"]>[0]> = [];
  const confirmations: string[] = [];
  const written: string[] = [];

  const ports: ProjectAutocreatePorts = {
    listRepos: () => {
      calls.push("list");
      return Promise.resolve(input.list ?? { status: "ok", installations: [] });
    },
    refresh: (installationId) => {
      calls.push(`refresh:${installationId}`);
      return Promise.resolve(input.refreshed?.[installationId]);
    },
    confirm: (message) => {
      confirmations.push(message);
      return Promise.resolve(input.confirm ?? true);
    },
    create: (args) => {
      created.push(args);
      return Promise.resolve(
        input.create ?? {
          status: "created",
          project: {
            projectId: "project-123",
            slug: "my-repo",
            ownerUsername: "octo",
            initialSyncFailed: false,
          },
        },
      );
    },
    writeConfig: (projectId) => {
      written.push(projectId);
      return Promise.resolve();
    },
  };
  return { ports, calls, created, confirmations, written };
}

function run(
  ports: ProjectAutocreatePorts,
  overrides: { interactive?: boolean; remoteUrl?: string } = {},
) {
  const recorder = createRecorder();
  const result = tryAutocreateGitHubProject({
    interactive: overrides.interactive ?? true,
    reporter: recorder.reporter,
    baseUrl: BASE_URL,
    remoteUrl: overrides.remoteUrl ?? REMOTE,
    suggestedName: "My-Repo",
    ports,
  });
  return { result, ...recorder };
}

describe("tryAutocreateGitHubProject", () => {
  test("creates the project from a matching repo (case-insensitive) after confirmation", async () => {
    const fake = fakePorts({
      list: {
        status: "ok",
        installations: [{ installationId: "inst-1", repos: [REPO] }],
      },
    });

    const { result, tasks } = run(fake.ports);

    expect(await result).toEqual({
      status: "created",
      projectId: "project-123",
    });
    expect(fake.confirmations).toEqual([
      confirmCreateMessage("My-Repo", "acme/my-repo"),
    ]);
    expect(fake.created).toEqual([
      { installationId: "inst-1", repo: REPO, name: "My-Repo" },
    ]);
    expect(fake.written).toEqual(["project-123"]);
    expect(fake.calls).toEqual(["list"]);
    expect(tasks).toEqual([
      { method: "startTask", message: CREATE_TASK_LABEL },
      { method: "succeed", message: "Created project “My-Repo”" },
    ]);
  });

  test("refreshes every installation on a miss, then matches again", async () => {
    const fake = fakePorts({
      list: {
        status: "ok",
        installations: [
          { installationId: "inst-1", repos: [] },
          { installationId: "inst-2", repos: [] },
        ],
      },
      refreshed: {
        "inst-1": undefined,
        "inst-2": { installationId: "inst-2", repos: [REPO] },
      },
    });

    const { result, tasks } = run(fake.ports);

    expect(await result).toEqual({
      status: "created",
      projectId: "project-123",
    });
    expect(fake.calls).toEqual(["list", "refresh:inst-1", "refresh:inst-2"]);
    expect(fake.created[0]?.installationId).toBe("inst-2");
    expect(tasks[0]).toEqual({
      method: "startTask",
      message: REFRESH_TASK_LABEL,
    });
  });

  test("skips with repo-not-installed when the refresh still misses", async () => {
    const fake = fakePorts({
      list: {
        status: "ok",
        installations: [{ installationId: "inst-1", repos: [] }],
      },
      refreshed: { "inst-1": { installationId: "inst-1", repos: [] } },
    });

    const { result } = run(fake.ports);

    expect(await result).toEqual({
      status: "skipped",
      reason: "repo-not-installed",
    });
    expect(fake.confirmations).toEqual([]);
    expect(fake.created).toEqual([]);
  });

  test("skips without asking when the user has no installations", async () => {
    const fake = fakePorts({ list: { status: "ok", installations: [] } });

    const { result } = run(fake.ports);

    expect(await result).toEqual({
      status: "skipped",
      reason: "repo-not-installed",
    });
    expect(fake.calls).toEqual(["list"]);
  });

  test("skips when the GitHub App is not configured on the server", async () => {
    const fake = fakePorts({ list: { status: "github-app-not-configured" } });

    const { result, calls } = run(fake.ports);

    expect(await result).toEqual({
      status: "skipped",
      reason: "github-app-not-configured",
    });
    expect(calls).toEqual([]);
  });

  test("skips with a warning when the repo list cannot load", async () => {
    const fake = fakePorts({
      list: { status: "failed", reason: "HTTP 500: boom" },
    });

    const { result, calls } = run(fake.ports);

    expect(await result).toEqual({
      status: "skipped",
      reason: "github-repos-unavailable",
    });
    expect(calls.map((call) => call.method)).toEqual(["warn"]);
  });

  test("skips non-GitHub remotes without calling the API", async () => {
    const fake = fakePorts({});

    const { result } = run(fake.ports, {
      remoteUrl: "git@gitlab.com:acme/my-repo.git",
    });

    expect(await result).toEqual({ status: "skipped", reason: "not-github" });
    expect(fake.calls).toEqual([]);
  });

  test("skips without calling the API when non-interactive", async () => {
    const fake = fakePorts({});

    const { result } = run(fake.ports, { interactive: false });

    expect(await result).toEqual({
      status: "skipped",
      reason: "noninteractive",
    });
    expect(fake.calls).toEqual([]);
  });

  test("skips when the user declines", async () => {
    const fake = fakePorts({
      list: {
        status: "ok",
        installations: [{ installationId: "inst-1", repos: [REPO] }],
      },
      confirm: false,
    });

    const { result } = run(fake.ports);

    expect(await result).toEqual({ status: "skipped", reason: "declined" });
    expect(fake.created).toEqual([]);
    expect(fake.written).toEqual([]);
  });

  test("falls back with a warning when creation fails, writing nothing", async () => {
    const fake = fakePorts({
      list: {
        status: "ok",
        installations: [{ installationId: "inst-1", repos: [REPO] }],
      },
      create: { status: "failed", reason: "HTTP 403: Forbidden" },
    });

    const { result, calls } = run(fake.ports);

    expect(await result).toEqual({
      status: "skipped",
      reason: "create-failed",
    });
    expect(fake.written).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["warn"]);
  });

  test("warns with the settings link when the initial issue sync failed", async () => {
    const fake = fakePorts({
      list: {
        status: "ok",
        installations: [{ installationId: "inst-1", repos: [REPO] }],
      },
      create: {
        status: "created",
        project: {
          projectId: "project-123",
          slug: "my-repo",
          ownerUsername: "octo",
          initialSyncFailed: true,
        },
      },
    });

    const { result, calls } = run(fake.ports);

    expect(await result).toEqual({
      status: "created",
      projectId: "project-123",
    });
    expect(messages(calls)).toContain(
      initialSyncFailedMessage(`${BASE_URL}/octo/my-repo/settings`),
    );
    expect(fake.written).toEqual(["project-123"]);
  });
});
