import type { createBoboddyClient } from "@boboddy/sdk";
import { describe, expect } from "bun:test";
import { ConfigurationError } from "../../../../src/lib/errors";
import { findMatchingProject } from "../../../../src/project/project-setup/application/find-matching-project";
import { concurrentTest } from "../../../utils";

const headers = { Authorization: "Bearer test-token" };
const LOCAL_SSH_REMOTE = "git@github.com:Acme/My-Repo.git";

type ProjectRow = {
  id: string;
  name: string;
  gitUrl: string;
  createdAt: string;
};

function project(overrides: Partial<ProjectRow> & { id: string }): ProjectRow {
  return {
    name: overrides.id,
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
