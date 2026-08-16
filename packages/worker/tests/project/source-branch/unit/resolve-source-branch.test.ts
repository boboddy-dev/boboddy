/**
 * Pure precedence/error-message tests for {@link resolveSourceBranch} against a
 * fake {@link SourceBranchGitPort} — no real git process involved. The real git
 * CLI implementation is covered separately in
 * `git-cli-source-branch-port.test.ts` against real temp repos.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveSourceBranch,
  SourceBranchVerificationError,
  type SourceBranchGitPort,
} from "../../../../src/project/source-branch/application/resolve-source-branch";

type FakeState = {
  isRepo: boolean;
  currentBranch: string | null;
  /** branch name -> remote SHA, absent means "does not exist on origin". */
  remoteShaByBranch: Record<string, string>;
  localHeadSha: string;
  /** ancestorSha -> set of shas it is an ancestor of. */
  ancestryEdges: Array<[string, string]>;
};

function buildFakeGitPort(state: FakeState): SourceBranchGitPort {
  return {
    isGitRepository: () => Promise.resolve(state.isRepo),
    getCurrentBranch: () => Promise.resolve(state.currentBranch),
    fetchRemoteBranchSha: (_cwd, branch) =>
      Promise.resolve(state.remoteShaByBranch[branch] ?? null),
    getSha: (_cwd, ref) =>
      Promise.resolve(ref === "HEAD" ? state.localHeadSha : ref),
    isAncestor: (_cwd, ancestorSha, descendantSha) =>
      Promise.resolve(
        state.ancestryEdges.some(
          ([a, d]) => a === ancestorSha && d === descendantSha,
        ),
      ),
  };
}

const CWD = "/fake/cwd";

describe("resolveSourceBranch", () => {
  test("returns null when cwd is not a git repository", async () => {
    const gitPort = buildFakeGitPort({
      isRepo: false,
      currentBranch: null,
      remoteShaByBranch: {},
      localHeadSha: "",
      ancestryEdges: [],
    });

    expect(await resolveSourceBranch({ cwd: CWD }, gitPort)).toEqual({
      branch: null,
    });
  });

  test("returns null on detached HEAD (no current branch)", async () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: null,
      remoteShaByBranch: {},
      localHeadSha: "sha-1",
      ancestryEdges: [],
    });

    expect(await resolveSourceBranch({ cwd: CWD }, gitPort)).toEqual({
      branch: null,
    });
  });

  test("resolves the current branch when it is in exact sync with origin", async () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: "feature-x",
      remoteShaByBranch: { "feature-x": "sha-1" },
      localHeadSha: "sha-1",
      ancestryEdges: [],
    });

    expect(await resolveSourceBranch({ cwd: CWD }, gitPort)).toEqual({
      branch: "feature-x",
      warning: undefined,
    });
  });

  test("fails when the current branch does not exist on origin", () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: "brand-new",
      remoteShaByBranch: {},
      localHeadSha: "sha-1",
      ancestryEdges: [],
    });

    expect(resolveSourceBranch({ cwd: CWD }, gitPort)).rejects.toThrow(
      SourceBranchVerificationError,
    );
    expect(resolveSourceBranch({ cwd: CWD }, gitPort)).rejects.toThrow(
      /does not exist on origin/,
    );
  });

  test("warns (without throwing) when the current branch has unpushed commits (local ahead of remote)", async () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: "feature-x",
      remoteShaByBranch: { "feature-x": "sha-remote" },
      localHeadSha: "sha-local",
      // remote is an ancestor of local => local has unpushed commits.
      ancestryEdges: [["sha-remote", "sha-local"]],
    });

    const result = await resolveSourceBranch({ cwd: CWD }, gitPort);
    expect(result.branch).toBe("feature-x");
    expect(result.warning).toMatch(/haven't been pushed/);
  });

  test("fails when the current branch is behind origin", () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: "feature-x",
      remoteShaByBranch: { "feature-x": "sha-remote" },
      localHeadSha: "sha-local",
      // local is an ancestor of remote => local is behind.
      ancestryEdges: [["sha-local", "sha-remote"]],
    });

    expect(resolveSourceBranch({ cwd: CWD }, gitPort)).rejects.toThrow(
      /is behind origin/,
    );
  });

  test("fails when the current branch has diverged from origin", () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: "feature-x",
      remoteShaByBranch: { "feature-x": "sha-remote" },
      localHeadSha: "sha-local",
      // Neither side is an ancestor of the other.
      ancestryEdges: [],
    });

    expect(resolveSourceBranch({ cwd: CWD }, gitPort)).rejects.toThrow(
      /diverged/,
    );
  });

  test("an explicit override wins and only requires existence on origin, not a local HEAD match", async () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: "my-local-branch",
      remoteShaByBranch: { "colleagues-branch": "sha-1" },
      localHeadSha: "sha-unrelated",
      ancestryEdges: [],
    });

    expect(
      await resolveSourceBranch(
        { cwd: CWD, override: "colleagues-branch" },
        gitPort,
      ),
    ).toEqual({ branch: "colleagues-branch" });
  });

  test("an explicit override that doesn't exist on origin fails fast", () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: "my-local-branch",
      remoteShaByBranch: {},
      localHeadSha: "sha-1",
      ancestryEdges: [],
    });

    expect(
      resolveSourceBranch({ cwd: CWD, override: "ghost-branch" }, gitPort),
    ).rejects.toThrow(/--source-branch/);
  });

  test("a blank override is treated as unset and falls back to current-branch resolution", async () => {
    const gitPort = buildFakeGitPort({
      isRepo: true,
      currentBranch: "feature-x",
      remoteShaByBranch: { "feature-x": "sha-1" },
      localHeadSha: "sha-1",
      ancestryEdges: [],
    });

    expect(
      await resolveSourceBranch({ cwd: CWD, override: "   " }, gitPort),
    ).toEqual({ branch: "feature-x", warning: undefined });
  });
});
