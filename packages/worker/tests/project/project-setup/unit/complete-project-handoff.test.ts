import type { createBoboddyClient } from "@boboddy/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect } from "bun:test";
import { completeProjectHandoff } from "../../../../src/project/project-setup/application/complete-project-handoff";
import { readProjectConfig } from "../../../../src/project/project-config/application/read-project-config";
import { concurrentTest } from "../../../utils";

const headers = { Authorization: "Bearer test-token" };
const gitUrl = "git@github.com:acme/my-repo.git";

function fakeClient(projects: Array<{ id: string; gitUrl: string }>) {
  return {
    projects: {
      listProjects: () =>
        Promise.resolve({
          data: projects.map((project) => ({
            name: project.id,
            createdAt: "2026-01-01T00:00:00.000Z",
            ...project,
          })),
        }),
    },
  } as unknown as ReturnType<typeof createBoboddyClient>;
}

/**
 * One check of the poll `init` runs during the browser hand-off (#141): a
 * single lookup that persists the project once it exists and reports a miss
 * as `undefined`.
 */
describe("completeProjectHandoff", () => {
  concurrentTest(
    "persists and returns the projectId once a matching project exists",
    async () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-handoff-"));
      try {
        const client = fakeClient([{ id: "new-project-id", gitUrl }]);

        const result = await completeProjectHandoff({
          client,
          headers,
          gitUrl,
          rootDir: tmpDir,
        });

        expect(result).toEqual({ projectId: "new-project-id" });
        expect(await readProjectConfig(tmpDir)).toEqual({
          projectId: "new-project-id",
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "returns undefined, and writes nothing, while no project matches yet",
    async () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-handoff-"));
      try {
        const client = fakeClient([]);

        expect(
          await completeProjectHandoff({
            client,
            headers,
            gitUrl,
            rootDir: tmpDir,
          }),
        ).toBeUndefined();

        expect(await readProjectConfig(tmpDir)).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "links a project stored with the HTTPS URL when the local remote is SSH",
    async () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-handoff-"));
      try {
        const client = fakeClient([
          {
            id: "github-project",
            gitUrl: "https://github.com/acme/my-repo.git",
          },
        ]);

        const result = await completeProjectHandoff({
          client,
          headers,
          gitUrl,
          rootDir: tmpDir,
        });

        expect(result).toEqual({ projectId: "github-project" });
        expect(await readProjectConfig(tmpDir)).toEqual({
          projectId: "github-project",
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  concurrentTest(
    "surfaces a project-list failure instead of reporting no match",
    async () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-handoff-"));
      try {
        const client = {
          projects: {
            listProjects: () =>
              Promise.resolve({
                data: undefined,
                error: { status: 500 },
                response: { status: 500 },
              }),
          },
        } as unknown as ReturnType<typeof createBoboddyClient>;

        let caught: unknown;
        try {
          await completeProjectHandoff({
            client,
            headers,
            gitUrl,
            rootDir: tmpDir,
          });
        } catch (error) {
          caught = error;
        }

        expect((caught as Error).message).toContain(
          "Could not load your projects",
        );
        expect(await readProjectConfig(tmpDir)).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  concurrentTest("ignores a project with a different gitUrl", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-handoff-"));
    try {
      const client = fakeClient([
        { id: "unrelated", gitUrl: "git@github.com:acme/other-repo.git" },
      ]);

      expect(
        await completeProjectHandoff({
          client,
          headers,
          gitUrl,
          rootDir: tmpDir,
        }),
      ).toBeUndefined();
      expect(await readProjectConfig(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
