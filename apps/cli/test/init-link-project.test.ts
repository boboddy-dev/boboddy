import type { createBoboddyClient } from "@boboddy/sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readProjectConfig, resolveGitRepository } from "@boboddy/worker";
import { linkInitProject, type LinkProjectPorts } from "../src/commands/init";
import type { ResolvedRepository } from "../src/lib/init-repository-resolution";
import { createReporterRecorder as createRecorder } from "./utils";

/**
 * `init` run from a nested directory of a repo must still anchor
 * `.boboddy/boboddy.jsonc` at the repository root — both when an existing
 * project matches and when it only appears after the browser hand-off.
 */

const REMOTE_URL = "git@github.com:acme/my-repo.git";
const headers = { Authorization: "Bearer test-token" };

function fakeClient(
  projectLists: Array<Array<{ id: string; gitUrl: string }>>,
) {
  let call = 0;
  return {
    projects: {
      listProjects: () => {
        const projects = projectLists[Math.min(call, projectLists.length - 1)];
        call += 1;
        return Promise.resolve({
          data: (projects ?? []).map((project) => ({
            name: project.id,
            createdAt: "2026-01-01T00:00:00.000Z",
            ...project,
          })),
        });
      },
    },
  } as unknown as ReturnType<typeof createBoboddyClient>;
}

function fakePorts(): LinkProjectPorts {
  return {
    autocreate: {
      listRepos: () =>
        Promise.resolve({ status: "github-app-not-configured" } as const),
      refresh: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(false),
      create: () => Promise.resolve({ status: "failed", reason: "unused" }),
      writeConfig: () => Promise.resolve(),
    },
    handoff: {
      openBrowser: () => Promise.resolve(),
      startCheckTrigger: () => ({
        wait: () => Promise.resolve("enter" as const),
        close: () => {},
      }),
      now: () => 0,
    },
  };
}

describe("linkInitProject from a nested directory", () => {
  let repoRoot: string;
  let nested: string;
  let repo: ResolvedRepository;

  beforeEach(async () => {
    repoRoot = mkdtempSync(resolve(tmpdir(), "boboddy-init-nested-"));
    execFileSync("git", ["-C", repoRoot, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      repoRoot,
      "remote",
      "add",
      "origin",
      REMOTE_URL,
    ]);
    nested = join(repoRoot, "packages", "app");
    mkdirSync(nested, { recursive: true });
    repo = await resolveGitRepository(nested);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("writes the matched project's config at the repo root", async () => {
    const { reporter } = createRecorder();

    await linkInitProject({
      baseUrl: "https://app.boboddy.dev",
      interactive: true,
      reporter,
      client: fakeClient([[{ id: "existing", gitUrl: REMOTE_URL }]]),
      headers,
      repo,
      ports: fakePorts(),
    });

    expect(await readProjectConfig(repoRoot)).toEqual({
      projectId: "existing",
    });
    expect(existsSync(join(nested, ".boboddy"))).toBe(false);
  });

  test("writes the config at the repo root once the browser hand-off finds the project", async () => {
    const { reporter } = createRecorder();

    await linkInitProject({
      baseUrl: "https://app.boboddy.dev",
      interactive: true,
      reporter,
      client: fakeClient([
        [],
        [],
        [
          {
            id: "created-in-browser",
            gitUrl: "https://github.com/acme/my-repo",
          },
        ],
      ]),
      headers,
      repo,
      ports: fakePorts(),
    });

    expect(await readProjectConfig(repoRoot)).toEqual({
      projectId: "created-in-browser",
    });
    expect(existsSync(join(nested, ".boboddy"))).toBe(false);
  });
});
