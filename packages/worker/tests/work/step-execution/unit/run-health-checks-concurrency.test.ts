import { afterEach, describe, expect, test } from "bun:test";
import { runHealthChecks } from "../../../../src/work/step-execution/application/run-health-checks";
import {
  healthCheck,
  installFakeAgent,
  restoreFetch,
  startedFakeAiServer,
} from "./helpers/fake-health-check-agent";

/**
 * `runHealthChecks — parallel lanes and serialGroup` — split out of
 * `run-health-checks.test.ts` to keep that file under the repo's `max-lines`
 * limit; see that file for `runHealthChecks`'s other coverage (severity
 * ordering, failure-reason mapping, timeouts, the MCP warm-up poll).
 *
 * Covers the concurrency model added on top of the original fully-sequential
 * runner: by default every check is its own lane and lanes run in parallel;
 * `serialGroup` opts specific checks back into strict, declaration-order
 * serialization against each other (e.g. checks contending over one shared
 * database or browser) without serializing the whole run.
 */
afterEach(() => {
  restoreFetch();
});

describe("runHealthChecks — parallel lanes and serialGroup", () => {
  test("without a serialGroup, required checks run in parallel — a later check is not skipped just because an earlier one failed", async () => {
    // This is the flip side of the "same serialGroup" test below: with no
    // grouping declared, pass_a/fail_b/pass_c are three independent lanes
    // (see `runPhase`) that all start at once, so pass_c's own outcome is
    // whatever it really was (passed), not "skipped" — there's no
    // declaration-order dependency between ungrouped checks to abort.
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          fixture_pass_a: { status: "completed" },
          fixture_fail_b: {
            status: "error",
            error: "b is broken",
          },
          fixture_pass_c: { status: "completed" },
          fixture_pass_d: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({ mcp: "fixture", tool: "pass_a", severity: "required" }),
          healthCheck({ mcp: "fixture", tool: "fail_b", severity: "required" }),
          healthCheck({ mcp: "fixture", tool: "pass_c", severity: "required" }),
          healthCheck({ mcp: "fixture", tool: "pass_d", severity: "warn" }),
        ],
        fakeAiServer,
      });

      expect(result.map((report) => report.outcome)).toEqual([
        { kind: "passed" },
        { kind: "failed", reason: "tool-error", detail: "b is broken" },
        { kind: "passed" },
        // The `warn` phase only starts once the whole `required` phase (every
        // lane) has settled, so it always sees the abort flag already set.
        { kind: "skipped" },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("checks sharing a serialGroup run one at a time, in declaration order, and abort the rest of their group on a required failure", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          fixture_pass_a: { status: "completed" },
          fixture_fail_b: {
            status: "error",
            error: "b is broken",
          },
          fixture_pass_c: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "pass_a",
            severity: "required",
            serialGroup: "shared-db",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "fail_b",
            severity: "required",
            serialGroup: "shared-db",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "pass_c",
            severity: "required",
            serialGroup: "shared-db",
          }),
        ],
        fakeAiServer,
      });

      expect(result.map((report) => report.outcome)).toEqual([
        { kind: "passed" },
        { kind: "failed", reason: "tool-error", detail: "b is broken" },
        // Same lane as fail_b, declared after it: never started.
        { kind: "skipped" },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("a serialGroup only serializes checks that share it — a different group (or no group) still runs concurrently", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          fixture_db_a: { status: "completed" },
          fixture_db_b: { status: "completed" },
          fixture_solo: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "db_a",
            severity: "required",
            serialGroup: "db",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "db_b",
            severity: "required",
            serialGroup: "db",
          }),
          healthCheck({ mcp: "fixture", tool: "solo", severity: "required" }),
        ],
        fakeAiServer,
      });

      expect(result.map((report) => report.outcome)).toEqual([
        { kind: "passed" },
        { kind: "passed" },
        { kind: "passed" },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("runs independent lanes concurrently — proven by overlapping open sessions, not timing", async () => {
    // Two `serialGroup` lanes, two checks each. `concurrentSessions.max`
    // (see `installFakeAgent`) counts the peak number of health-check
    // sessions open at once: if this runner were still fully sequential
    // (the old behavior), only one session would ever be open at a time and
    // `max` would be 1. Seeing `max > 1` proves at least two lanes had
    // in-flight forced calls simultaneously — a real, non-flaky assertion
    // that doesn't depend on wall-clock timing or artificial delays.
    const fakeAiServer = await startedFakeAiServer();
    try {
      const { concurrentSessions } = installFakeAgent({
        toolStates: {
          fixture_lane1_a: { status: "completed" },
          fixture_lane1_b: { status: "completed" },
          fixture_lane2_a: { status: "completed" },
          fixture_lane2_b: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "lane1_a",
            severity: "required",
            serialGroup: "lane1",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "lane1_b",
            severity: "required",
            serialGroup: "lane1",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "lane2_a",
            severity: "required",
            serialGroup: "lane2",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "lane2_b",
            severity: "required",
            serialGroup: "lane2",
          }),
        ],
        fakeAiServer,
      });

      expect(result.every((report) => report.outcome.kind === "passed")).toBe(
        true,
      );
      expect(concurrentSessions.max).toBeGreaterThan(1);
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("best-effort abort only skips the failing check's own lane — an unrelated solo check is unaffected", async () => {
    // "best-effort" (as opposed to a hard stop): there is no cancellation
    // mechanism here, so the ONLY checks ever reported `skipped` are ones a
    // lane's own for-loop hadn't reached yet when the shared abort flag
    // flipped. `solo` shares no `serialGroup` with the failing `db` lane, so
    // it is never even consulted about the abort flag until its own single
    // iteration — which, since it's the very first (and only) check in its
    // lane, has effectively already started by the time any other lane could
    // fail. It always reports its real outcome.
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        toolStates: {
          fixture_db_a: { status: "completed" },
          fixture_db_fails: {
            status: "error",
            error: "db is broken",
          },
          fixture_db_c: { status: "completed" },
          fixture_solo: { status: "completed" },
        },
      });

      const result = await runHealthChecks({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        healthChecks: [
          healthCheck({
            mcp: "fixture",
            tool: "db_a",
            severity: "required",
            serialGroup: "db",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "db_fails",
            severity: "required",
            serialGroup: "db",
          }),
          healthCheck({
            mcp: "fixture",
            tool: "db_c",
            severity: "required",
            serialGroup: "db",
          }),
          healthCheck({ mcp: "fixture", tool: "solo", severity: "required" }),
        ],
        fakeAiServer,
      });

      expect(result.map((report) => report.outcome)).toEqual([
        { kind: "passed" },
        { kind: "failed", reason: "tool-error", detail: "db is broken" },
        // Same lane, declared after the failure: never started.
        { kind: "skipped" },
        // Different lane entirely: unaffected by the "db" lane's failure.
        { kind: "passed" },
      ]);
    } finally {
      await fakeAiServer.stop();
    }
  });
});
