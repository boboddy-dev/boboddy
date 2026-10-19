import type { createBoboddyClient } from "@boboddy/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigurationError } from "../../../../src/lib/errors";
import { readProjectConfig } from "../../../../src/project/project-config/application/read-project-config";
import { writeProjectConfig } from "../../../../src/project/project-config/application/write-project-config";
import { findMatchingProject } from "../../../../src/project/project-setup/application/find-matching-project";
import { localConfigSetup } from "../../../../src/project/project-setup/application/local-config-setup";
import { git } from "../../../runtime/runtime-service/unit/git-test-fixtures";
import { concurrentTest } from "../../../utils";

const headers = { Authorization: "Bearer test-token" };
const LOCAL_SSH_REMOTE = "git@github.com:Acme/My-Repo.git";

type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  ownerUsername: string | null;
  gitUrl: string;
  createdAt: string;
};

function project(overrides: Partial<ProjectRow> & { id: string }): ProjectRow {
  return {
    name: overrides.id,
    slug: overrides.id,
    ownerUsername: "acme",
    gitUrl: "https://github.com/acme/other.git",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeClient(projects: ProjectRow[]) {
  return {
    projects: {
      listProjects: () => Promise.resolve({ data: projects }),
    },
  } as unknown as ReturnType<typeof createBoboddyClient>;
}

describe("findMatchingProject", () => {
  concurrentTest(
    "returns the project whose gitUrl matches exactly",
    async () => {
      const theProject = project({
        id: "the-project",
        gitUrl: "git@github.com:acme/my-repo.git",
      });
      const client = fakeClient([
        project({
          id: "other-project",
          gitUrl: "git@github.com:acme/other.git",
        }),
        theProject,
      ]);

      const result = await findMatchingProject({
        client,
        headers,
        gitUrl: "git@github.com:acme/my-repo.git",
      });

      expect(result).toEqual({ project: theProject, matchCount: 1 });
    },
  );

  concurrentTest(
    "matches a local SSH remote against the HTTPS URL the GitHub picker stores",
    async () => {
      const stored = project({
        id: "github-project",
        gitUrl: "https://github.com/acme/my-repo.git",
      });
      const client = fakeClient([stored]);

      const result = await findMatchingProject({
        client,
        headers,
        gitUrl: LOCAL_SSH_REMOTE,
      });

      expect(result?.project).toEqual(stored);
    },
  );

  concurrentTest(
    "picks the oldest project, then the lowest id, and reports how many matched",
    async () => {
      const client = fakeClient([
        project({
          id: "c-newest",
          gitUrl: "https://github.com/acme/my-repo",
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
        project({
          id: "b-oldest",
          gitUrl: "ssh://git@github.com/acme/my-repo.git",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        project({
          id: "a-oldest",
          gitUrl: "https://github.com/acme/my-repo.git",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        project({ id: "unrelated" }),
      ]);

      const result = await findMatchingProject({
        client,
        headers,
        gitUrl: LOCAL_SSH_REMOTE,
      });

      expect(result?.project.id).toBe("a-oldest");
      expect(result?.matchCount).toBe(3);
    },
  );

  concurrentTest(
    "falls back to exact equality for remotes with no identity key",
    async () => {
      const local = project({ id: "local", gitUrl: "/srv/git/my-repo.git" });
      const client = fakeClient([
        project({ id: "near-miss", gitUrl: "/srv/git/my-repo" }),
        local,
      ]);

      const result = await findMatchingProject({
        client,
        headers,
        gitUrl: "/srv/git/my-repo.git",
      });

      expect(result).toEqual({ project: local, matchCount: 1 });
    },
  );

  concurrentTest("returns undefined when no project matches", async () => {
    const client = fakeClient([
      project({ id: "other-project", gitUrl: "git@github.com:acme/other.git" }),
    ]);

    const result = await findMatchingProject({
      client,
      headers,
      gitUrl: LOCAL_SSH_REMOTE,
    });

    expect(result).toBeUndefined();
  });

  concurrentTest("treats a null/missing data list as no projects", async () => {
    const client = {
      projects: { listProjects: () => Promise.resolve({ data: null }) },
    } as unknown as ReturnType<typeof createBoboddyClient>;

    const result = await findMatchingProject({
      client,
      headers,
      gitUrl: LOCAL_SSH_REMOTE,
    });

    expect(result).toBeUndefined();
  });

  concurrentTest(
    "throws instead of reporting no match when the list request fails",
    async () => {
      const client = {
        projects: {
          listProjects: () =>
            Promise.resolve({
              data: undefined,
              error: { status: 401, title: "Unauthorized" },
              response: { status: 401 },
            }),
        },
      } as unknown as ReturnType<typeof createBoboddyClient>;

      let caught: unknown;
      try {
        await findMatchingProject({
          client,
          headers,
          gitUrl: LOCAL_SSH_REMOTE,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as Error).message).toContain("HTTP 401");
    },
  );
});

describe("localConfigSetup", () => {
  const REMOTE_URL = "git@github.com:acme/my-repo.git";
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "local-config-setup-"));
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["remote", "add", "origin", REMOTE_URL]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("skips entirely when already configured", async () => {
    await writeProjectConfig("acme/already-configured", repo);

    const result = await localConfigSetup({
      client: fakeClient([]),
      headers,
      rootDir: repo,
    });

    expect(result).toEqual({ status: "already-configured" });
  });

  test("picks the oldest of several matching projects and reports the count", async () => {
    const client = fakeClient([
      project({
        id: "newer",
        gitUrl: "https://github.com/acme/my-repo.git",
        createdAt: "2026-02-01T00:00:00.000Z",
      }),
      project({
        id: "older",
        gitUrl: REMOTE_URL,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const result = await localConfigSetup({ client, headers, rootDir: repo });

    expect(result).toEqual({
      status: "matched",
      projectId: "older",
      project: "acme/older",
      projectName: "older",
      matchCount: 2,
    });
  });

  test("does NOT call createProject and returns handoff-required when no project matches", async () => {
    let createProjectCalls = 0;
    const client = {
      projects: {
        listProjects: () => Promise.resolve({ data: [] }),
        createProject: () => {
          createProjectCalls += 1;
          return Promise.resolve({ data: { id: "should-not-be-created" } });
        },
      },
    } as unknown as ReturnType<typeof createBoboddyClient>;

    const result = await localConfigSetup({ client, headers, rootDir: repo });

    expect(result).toEqual({
      status: "handoff-required",
      gitUrl: REMOTE_URL,
      suggestedName: "my-repo",
    });
    expect(createProjectCalls).toBe(0);
    expect(await readProjectConfig(repo)).toBeNull();
  });
});
