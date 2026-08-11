import type { createBoboddyClient } from "@boboddy/sdk";
import { describe, expect } from "bun:test";
import { findMatchingProject } from "../../../../src/project/project-setup/application/find-matching-project";
import { concurrentTest } from "../../../utils";

const headers = { Authorization: "Bearer test-token" };

function fakeClient(projects: Array<{ id: string; gitUrl: string }>) {
  return {
    projects: {
      listProjects: () => Promise.resolve({ data: projects }),
    },
  } as unknown as ReturnType<typeof createBoboddyClient>;
}

describe("findMatchingProject", () => {
  concurrentTest("returns the project whose gitUrl matches", async () => {
    const client = fakeClient([
      { id: "other-project", gitUrl: "git@github.com:acme/other.git" },
      { id: "the-project", gitUrl: "git@github.com:acme/my-repo.git" },
    ]);

    const result = await findMatchingProject({
      client,
      headers,
      gitUrl: "git@github.com:acme/my-repo.git",
    });

    expect(result).toEqual({
      id: "the-project",
      gitUrl: "git@github.com:acme/my-repo.git",
    });
  });

  concurrentTest("returns undefined when no project matches", async () => {
    const client = fakeClient([
      { id: "other-project", gitUrl: "git@github.com:acme/other.git" },
    ]);

    const result = await findMatchingProject({
      client,
      headers,
      gitUrl: "git@github.com:acme/my-repo.git",
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
      gitUrl: "git@github.com:acme/my-repo.git",
    });

    expect(result).toBeUndefined();
  });
});
