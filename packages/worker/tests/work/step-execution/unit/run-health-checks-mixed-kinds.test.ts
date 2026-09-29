import { afterEach, describe, expect, test } from "bun:test";
import { runHealthChecks } from "../../../../src/work/step-execution/application/run-health-checks";
import {
  cliHealthCheck,
  healthCheck,
  installFakeAgent,
  restoreFetch,
  startedFakeAiServer,
} from "./helpers/fake-health-check-agent";

/**
 * `runHealthChecks — mixed "tool"/"cli" kinds` — proves the `kind` union
 * (Phase 2, `packages/sdks/js/src/health-checks.ts`) is genuinely orthogonal
 * to `runPhase`/`runLane`'s scheduling model (declared checks run in
 * parallel lanes by default; `serialGroup` opts checks into strict,
 * declaration-order serialization against each other — see
 * `run-health-checks-concurrency.test.ts` for the same-kind version of this
 * coverage), not just type-compatible by accident. Split into its own file
 * per the same `max-lines` convention `run-health-checks-concurrency.test.ts`
 * documents.
 */
afterEach(() => {
  restoreFetch();
});

describe("runHealthChecks — mixed tool/cli kinds", () => {
  test("an ungrouped required tool check and required cli check run concurrently and both report correctly, tool-then-cli declaration order", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { concurrentSessions } = installFakeAgent({
        toolStates: {
          fixture_check_a: { status: "completed" },
          bash: { status: "completed", exit: 0 },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "check_a",
            severity: "required",
          }),
          cliHealthCheck({
            command: ["gh", "--version"],
            severity: "required",
          }),
        ],
        fakeAiServer,
      });

      expect(result).toEqual([
        {
          name: "fixture_check_a",
          resolvedId: "fixture_check_a",
          severity: "required",
          kind: "tool",
          outcome: { kind: "passed" },
        },
        {
          name: "gh --version",
          resolvedId: "gh --version",
          severity: "required",
          kind: "cli",
          outcome: { kind: "passed" },
        },
      ]);
      expect(concurrentSessions.max).toBeGreaterThan(1);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("an ungrouped required cli check and required tool check run concurrently and both report correctly, cli-then-tool declaration order", async () => {
    // The flip side of the previous test: same two checks, declared in the
    // opposite order, proving the outcome doesn't depend on which kind was
    // declared first.
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { concurrentSessions } = installFakeAgent({
        toolStates: {
          fixture_check_a: { status: "completed" },
          bash: { status: "completed", exit: 0 },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          cliHealthCheck({
            command: ["gh", "--version"],
            severity: "required",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "check_a",
            severity: "required",
          }),
        ],
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
        {
          name: "fixture_check_a",
          resolvedId: "fixture_check_a",
          severity: "required",
          kind: "tool",
          outcome: { kind: "passed" },
        },
      ]);
      expect(concurrentSessions.max).toBeGreaterThan(1);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("a cli check and a tool check sharing one serialGroup run strictly one at a time, in declaration order", async () => {
    // `concurrentSessions.max === 1` is the same non-flaky, timing-independent
    // proof `run-health-checks-concurrency.test.ts` uses for same-kind lanes:
    // if the lane logic treated `"cli"` and `"tool"` checks any differently,
    // this would see overlapping sessions (max > 1) instead.
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { concurrentSessions } = installFakeAgent({
        toolStates: {
          bash: { status: "completed", exit: 0 },
          fixture_check_b: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          cliHealthCheck({
            command: ["gh", "--version"],
            severity: "required",
            serialGroup: "shared-lane",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "check_b",
            severity: "required",
            serialGroup: "shared-lane",
          }),
          cliHealthCheck({
            command: ["node", "--version"],
            severity: "required",
            serialGroup: "shared-lane",
          }),
        ],
        fakeAiServer,
      });

      expect(result.map((report) => report.outcome)).toEqual([
        { kind: "passed" },
        { kind: "passed" },
        { kind: "passed" },
      ]);
      expect(concurrentSessions.max).toBe(1);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("a required cli check failing aborts a later tool check sharing its serialGroup, reporting it skipped", async () => {
    // Reuses the abort-flag assertion pattern from
    // `run-health-checks.test.ts` ("runs required checks declared after a
    // warn check before that warn check") and
    // `run-health-checks-concurrency.test.ts` ("checks sharing a serialGroup
    // ... abort the rest of their group on a required failure"), but with
    // the FAILING check on the cli side this time — proving the abort flag
    // doesn't only work when the first failure happens to be a tool check.
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          bash: { status: "completed", exit: 1 },
          fixture_check_c: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          cliHealthCheck({
            command: ["false"],
            expectExitCode: 0,
            severity: "required",
            serialGroup: "shared-lane",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "check_c",
            severity: "required",
            serialGroup: "shared-lane",
          }),
        ],
        fakeAiServer,
      });

      expect(result[0]?.outcome.kind).toBe("failed");
      if (result[0]?.outcome.kind === "failed") {
        expect(result[0].outcome.reason).toBe("nonzero-exit");
      }
      // Same lane, declared after the cli failure: never started.
      expect(result[1]?.outcome).toEqual({ kind: "skipped" });
    } finally {
      await fakeAiServer.stop();
    }
  });
});
