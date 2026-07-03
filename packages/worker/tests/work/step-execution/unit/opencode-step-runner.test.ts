import { describe, expect, test } from "bun:test";
import { DefaultOpencodeStepRunner } from "../../../../src/work/step-execution/infra/opencode-step-runner";

describe("DefaultOpencodeStepRunner", () => {
  test("treats busy and retry session statuses as running", async () => {
    const fetchMock = (() => {
      let callCount = 0;
      return () => {
        callCount += 1;
        const data =
          callCount === 1
            ? { "session-busy": { type: "busy" } }
            : { "session-retry": { type: "retry", attempt: 1, message: "Retry", next: Date.now() + 1_000 } };
        return Promise.resolve(new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }));
      };
    })();

    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const runner = new DefaultOpencodeStepRunner();

      expect(await runner.getSessionStatus({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        sessionId: "session-busy",
      })).toEqual({ running: true, providerError: undefined });

      // A retry status carries the upstream provider error, which is surfaced
      // so the worker can log AI-provider failures distinctly.
      expect(await runner.getSessionStatus({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        sessionId: "session-retry",
      })).toEqual({
        running: true,
        providerError: { attempt: 1, message: "Retry" },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("treats idle and missing session statuses as stopped", async () => {
    const fetchMock = (() => {
      let callCount = 0;
      return () => {
        callCount += 1;
        const data = callCount === 1 ? { "session-idle": { type: "idle" } } : {};
        return Promise.resolve(new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }));
      };
    })();

    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const runner = new DefaultOpencodeStepRunner();

      expect(await runner.getSessionStatus({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        sessionId: "session-idle",
      })).toEqual({ running: false });

      expect(await runner.getSessionStatus({
        agentBaseUrl: "http://127.0.0.1:4096",
        workspaceFolder: "/workspaces/repo",
        sessionId: "session-missing",
      })).toEqual({ running: false });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
