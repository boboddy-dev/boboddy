import { afterEach, describe, expect, test } from "bun:test";
import { runHealthChecks } from "../../../../src/work/step-execution/application/run-health-checks";
import {
  cliHealthCheck,
  installFakeAgent,
  restoreFetch,
  startedFakeAiServer,
} from "./helpers/fake-health-check-agent";

/**
 * `runHealthChecks — "cli"-kind checks` — split out of `run-health-checks.test.ts`
 * (which only covers `"tool"`-kind checks) to keep both files under the
 * repo's `max-lines` limit, per that file's split-file convention.
 *
 * These are the regression tests for the bug this feature exists to fix
 * (see `docs/plans/health-check-cli-kind.md`): OpenCode's `bash` tool call
 * "completes" whether the command it ran succeeded or not, so a cli check's
 * verifier (`forceAndVerifyCliHealthCheck`) must read the real exit code back
 * out of the tool result rather than treating call-completion as a pass.
 */
afterEach(() => {
  restoreFetch();
});

describe("runHealthChecks — cli-kind checks", () => {
  test("passes when the command's real exit code matches the default expectExitCode (0)", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          bash: { status: "completed", exit: 0, output: "gh version 2.40.0" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [cliHealthCheck({ command: ["gh", "--version"] })],
        fakeAiServer,
      });

      expect(result).toEqual([
        {
          name: "gh --version",
          resolvedId: "gh --version",
          severity: "required",
          kind: "cli",
          outcome: { kind: "passed" },
        },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("fails as nonzero-exit when the command's real exit code doesn't match a declared expectExitCode, with an informative detail", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          bash: {
            status: "completed",
            exit: 1,
            output: "some diagnostic output from the failing command",
          },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          cliHealthCheck({ command: ["false"], expectExitCode: 0 }),
        ],
        fakeAiServer,
      });

      expect(result[0]?.outcome.kind).toBe("failed");
      if (result[0]?.outcome.kind === "failed") {
        expect(result[0].outcome.reason).toBe("nonzero-exit");
        expect(result[0].outcome.detail).toContain("1");
        expect(result[0].outcome.detail).toContain("0");
        expect(result[0].outcome.detail).toContain(
          "some diagnostic output from the failing command",
        );
      }
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("times out rather than hanging forever when the bash tool call never resolves", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: { bash: { status: "pending" } },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          cliHealthCheck({ command: ["gh", "--version"], timeoutMs: 100 }),
        ],
        fakeAiServer,
      });

      expect(result[0]?.outcome).toEqual({
        kind: "failed",
        reason: "timeout",
        detail: "timed out after 0s",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("reports nonzero-exit (not passed) for a command that doesn't exist — the exact bug this verifier fixes", async () => {
    // Regression test: a bash call for a missing binary still reaches
    // `status: "completed"` (exit 127 is just part of the result, not a tool
    // error) — the old "status === completed → passed" logic this feature
    // replaces would have reported this as passed.
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          bash: {
            status: "completed",
            exit: 127,
            output: "bash: totally-fake-binary: command not found",
          },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          cliHealthCheck({
            command: ["totally-fake-binary", "--version"],
            expectExitCode: 0,
          }),
        ],
        fakeAiServer,
      });

      expect(result[0]?.outcome).not.toEqual({ kind: "passed" });
      expect(result[0]?.outcome.kind).toBe("failed");
      if (result[0]?.outcome.kind === "failed") {
        expect(result[0].outcome.reason).toBe("nonzero-exit");
        expect(result[0].outcome.detail).toContain("127");
      }
    } finally {
      await fakeAiServer.stop();
    }
  });
});
