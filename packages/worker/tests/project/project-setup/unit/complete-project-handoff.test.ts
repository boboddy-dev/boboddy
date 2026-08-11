import type { createBoboddyClient } from "@boboddy/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect } from "bun:test";
import { ConfigurationError } from "../../../../src/lib/errors";
import { completeProjectHandoff } from "../../../../src/project/project-setup/application/complete-project-handoff";
import { readProjectConfig } from "../../../../src/project/project-config/application/read-project-config";
import { concurrentTest } from "../../../utils";

const headers = { Authorization: "Bearer test-token" };
const gitUrl = "git@github.com:acme/my-repo.git";

function fakeClient(projects: Array<{ id: string; gitUrl: string }>) {
  return {
    projects: {
      listProjects: () => Promise.resolve({ data: projects }),
    },
  } as unknown as ReturnType<typeof createBoboddyClient>;
}

/**
 * The re-check `init` runs once the user presses Enter after the browser
 * hand-off (#141) — a single lookup, not a poll loop.
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
    "throws a ConfigurationError, and writes nothing, when still no project matches",
    async () => {
      const tmpDir = mkdtempSync(resolve(tmpdir(), "boboddy-handoff-"));
      try {
        const client = fakeClient([]);

        expect(
          completeProjectHandoff({ client, headers, gitUrl, rootDir: tmpDir }),
        ).rejects.toBeInstanceOf(ConfigurationError);

        // Confirm no config was written as a side effect of the failed attempt.
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
        completeProjectHandoff({ client, headers, gitUrl, rootDir: tmpDir }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(await readProjectConfig(tmpDir)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
