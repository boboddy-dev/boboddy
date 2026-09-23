import { describe, expect, test } from "bun:test";
import { investigateExecution } from "../src/investigate-execution";
import type { InvestigateExecutionClient } from "../src/lib/investigate-execution-client";
import type { ApiErrorBody } from "../src/lib/api-types";
import {
  makeArtifact,
  makeArtifactDownloadUrl,
  makeAttempt,
  makeExecution,
  makePipelineDefinition,
  makeStepExecution,
  makeWorkItem,
} from "./fixtures";

const headers = { Authorization: "Bearer test-token" };

/**
 * A fully-populated fake `InvestigateExecutionClient`: every method resolves
 * to a sensible happy-path default built from the shared fixtures. Tests
 * override individual methods by spreading over the relevant namespace.
 */
function buildFakeClient(): InvestigateExecutionClient {
  const execution = makeExecution();
  const pipelineDefinition = makePipelineDefinition();
  const workItem = makeWorkItem();
  // Live (not-yet-completed) by default, so tests that don't care about logs
  // never accidentally hit the archive path (which calls real `fetch`).
  const stepExecution = makeStepExecution({ completedAt: null });

  return {
    pipelineExecutions: {
      getPipelineExecution: () =>
        Promise.resolve({ data: execution, error: undefined }),
    },
    pipelineDefinitions: {
      getPipelineDefinition: () =>
        Promise.resolve({ data: pipelineDefinition, error: undefined }),
    },
    workItems: {
      getWorkItem: () => Promise.resolve({ data: workItem, error: undefined }),
    },
    stepExecutions: {
      getStepExecution: () =>
        Promise.resolve({ data: stepExecution, error: undefined }),
      readStepExecutionLogs: () =>
        Promise.resolve({
          data: { lines: [], nextOffset: 0, complete: false },
          error: undefined,
        }),
      getStepExecutionLogArchive: () =>
        Promise.resolve({ data: { url: null, sizeBytes: 0 }, error: undefined }),
      listStepExecutionArtifacts: () =>
        Promise.resolve({ data: [], error: undefined }),
      getArtifactDownloadUrl: () =>
        Promise.resolve({ data: makeArtifactDownloadUrl(), error: undefined }),
    },
  };
}

function errorResult(error: ApiErrorBody): {
  data: undefined;
  error: ApiErrorBody;
} {
  return { data: undefined, error };
}

describe("investigateExecution", () => {
  test("happy path: no flags returns the execution summary", async () => {
    const client = buildFakeClient();

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
    });

    expect(output).toContain("Pipeline execution");
    expect(output).toContain("Steps:");
  });

  test("happy path: --step returns step detail", async () => {
    const client = buildFakeClient();

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
    });

    expect(output).toContain("Step: investigate");
    expect(output).toContain("Status: ✓ satisfied");
  });

  test("happy path: --log fetches the live feed for a running step", async () => {
    const client = buildFakeClient();
    client.stepExecutions.readStepExecutionLogs = () =>
      Promise.resolve({
        data: {
          lines: [
            {
              seq: 0,
              stream: "worker",
              ts: "2026-01-01T00:00:00.000Z",
              content: "starting up",
              level: "info",
            },
          ],
          nextOffset: 1,
          complete: false,
        },
        error: undefined,
      });

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      log: true,
    });

    expect(output).toContain("Step: investigate");
    expect(output).toContain("live, step still running");
    expect(output).toContain("starting up");
  });

  test("happy path: --artifacts lists artifacts with download URLs", async () => {
    const client = buildFakeClient();
    client.stepExecutions.listStepExecutionArtifacts = () =>
      Promise.resolve({ data: [makeArtifact()], error: undefined });

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      artifacts: true,
    });

    expect(output).toContain("Artifacts for step investigate:");
    expect(output).toContain("trace.zip");
  });

  test("attempt not found: throws a clear error naming the available attempts", () => {
    const client = buildFakeClient();

    expect(
      investigateExecution({
        client,
        headers,
        executionId: makeExecution().id,
        attempt: 99,
      }),
    ).rejects.toThrow(/Attempt 99 not found.*Available attempts: 1/);
  });

  test("step not found: throws a clear error naming the known steps", () => {
    const client = buildFakeClient();

    expect(
      investigateExecution({
        client,
        headers,
        executionId: makeExecution().id,
        step: "does-not-exist",
      }),
    ).rejects.toThrow(/Step "does-not-exist" not found.*Known steps: investigate/);
  });

  test("execution not found (404): throws a distinct not-found error", () => {
    const client = buildFakeClient();
    client.pipelineExecutions.getPipelineExecution = () =>
      Promise.resolve(errorResult({ status: 404, title: "Not Found" }));

    expect(
      investigateExecution({
        client,
        headers,
        executionId: "missing-id",
      }),
    ).rejects.toThrow(/Pipeline execution missing-id not found/);
  });

  test("log archive metered (402): surfaces a distinct quota message, not a generic failure", async () => {
    const client = buildFakeClient();
    // Terminal step execution so investigateExecution takes the archive path.
    client.stepExecutions.getStepExecution = () =>
      Promise.resolve({
        data: makeStepExecution({ completedAt: "2026-01-01T00:05:00.000Z" }),
        error: undefined,
      });
    client.stepExecutions.getStepExecutionLogArchive = () =>
      Promise.resolve(
        errorResult({
          status: 402,
          title: "Payment Required",
          detail: "USAGE_LIMIT_EXCEEDED_READ",
        }),
      );

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      log: true,
    });

    expect(output).toContain("log archive read quota exceeded");
    // The distinct 402 message, not a generic "could not load" failure.
    expect(output).not.toContain("could not load log archive");
  });

  test("artifact expired (410): reports that one artifact expired without failing the rest", async () => {
    const client = buildFakeClient();
    const expiring = makeArtifact({ id: "artifact-expired", relativeStorePath: "old.log" });
    const healthy = makeArtifact({ id: "artifact-healthy", relativeStorePath: "fresh.log" });
    client.stepExecutions.listStepExecutionArtifacts = () =>
      Promise.resolve({ data: [expiring, healthy], error: undefined });
    client.stepExecutions.getArtifactDownloadUrl = (options) => {
      if (options.path.artifactId === "artifact-expired") {
        return Promise.resolve(errorResult({ status: 410, title: "Gone" }));
      }
      return Promise.resolve({
        data: makeArtifactDownloadUrl({ relativeStorePath: "fresh.log" }),
        error: undefined,
      });
    };

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      step: "investigate",
      artifacts: true,
    });

    expect(output).toContain("old.log");
    expect(output).toContain("(unavailable: expired)");
    expect(output).toContain("fresh.log");
    expect(output).toContain("https://storage.example.test/trace.zip");
  });

  test("no step to show logs for: attempt has not started any steps", () => {
    const client = buildFakeClient();
    client.pipelineExecutions.getPipelineExecution = () =>
      Promise.resolve({
        data: makeExecution({
          attempts: [makeAttempt({ currentStepKey: null, stepRuns: [] })],
        }),
        error: undefined,
      });

    expect(
      investigateExecution({
        client,
        headers,
        executionId: makeExecution().id,
        log: true,
      }),
    ).rejects.toThrow(/has not started any steps yet/);
  });

  test("--log without --step defaults to the attempt's current step", async () => {
    const client = buildFakeClient();

    const output = await investigateExecution({
      client,
      headers,
      executionId: makeExecution().id,
      log: true,
    });

    expect(output).toContain("Showing --log/--artifacts for step investigate");
  });
});
