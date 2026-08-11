/**
 * Unit tests for {@link localConfigSetup} (#141).
 *
 * It used to silently `POST /projects` when no project matched the resolved
 * remote. It no longer does — a miss now returns `{ status: "handoff-required" }`
 * so the caller (`boboddy init`) can send the user through a browser hand-off
 * instead. This uses a real temp git repo, mirroring
 * `resolve-git-repository.test.ts`'s style, since `localConfigSetup` shells
 * out via `resolveGitRepository`.
 */
import type { createBoboddyClient } from "@boboddy/sdk";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { localConfigSetup } from "../../../../src/project/project-setup/application/local-config-setup";
import { readProjectConfig } from "../../../../src/project/project-config/application/read-project-config";
import { writeProjectConfig } from "../../../../src/project/project-config/application/write-project-config";

const execFileAsync = promisify(execFile);
const headers = { Authorization: "Bearer test-token" };
const REMOTE_URL = "git@github.com:acme/my-repo.git";

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function fakeClient(projects: Array<{ id: string; gitUrl: string }>) {
  return {
    projects: {
      listProjects: () => Promise.resolve({ data: projects }),
    },
  } as unknown as ReturnType<typeof createBoboddyClient>;
}

describe("localConfigSetup", () => {
  // Not concurrent: each test needs its own repo and shares mutable bindings,
  // same rationale as `resolveGitRepository`'s describe block.
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
    await writeProjectConfig("already-configured-id", repo);

    const client = fakeClient([]);
    const result = await localConfigSetup({ client, headers, rootDir: repo });

    expect(result).toEqual({ status: "already-configured" });
  });

  test("matches and persists an existing project by gitUrl (fast path, unchanged)", async () => {
    const client = fakeClient([{ id: "existing-id", gitUrl: REMOTE_URL }]);

    const result = await localConfigSetup({ client, headers, rootDir: repo });

    expect(result).toEqual({ status: "matched", projectId: "existing-id" });
    expect(await readProjectConfig(repo)).toEqual({
      projectId: "existing-id",
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
    // No config written yet — that only happens after the browser hand-off
    // completes (see `completeProjectHandoff`).
    expect(await readProjectConfig(repo)).toBeNull();
  });
});
