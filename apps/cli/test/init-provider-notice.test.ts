import { describe, expect } from "bun:test";
import {
  PROVIDER_MISSING_LABEL,
  PROVIDER_NOTICE_MESSAGE,
  PROVIDER_PRESENT_LABEL,
  PROVIDER_TASK_LABEL,
  reportProviderStatus,
} from "../src/lib/init-provider-notice";
import {
  concurrentTest as test,
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
  reportedMethods as methods,
} from "./utils";

/**
 * The AI-provider step of `boboddy init`: a notice, never a gate. Connecting a
 * provider is the designer preflight's job, so a missing one must resolve the
 * step and let `init` carry on.
 */

describe("reportProviderStatus", () => {
  test("reports a connected provider as a resolved task", async () => {
    const { reporter, calls, tasks } = createRecorder();

    const result = await reportProviderStatus({
      reporter,
      ports: {
        checkCredentials: () =>
          Promise.resolve({ ok: true, providers: ["anthropic", "openai"] }),
      },
    });

    expect(result).toEqual({ connected: true });
    expect(tasks[0]?.message).toBe(PROVIDER_TASK_LABEL);
    expect(methods(tasks)).toEqual(["startTask", "succeed"]);
    expect(tasks[1]?.message).toBe("AI provider ready (anthropic, openai)");
    expect(tasks[1]?.message).toBe(
      PROVIDER_PRESENT_LABEL(["anthropic", "openai"]),
    );
    expect(calls).toEqual([]);
  });

  test("a missing provider resolves the task and informs, without warning", async () => {
    const { reporter, calls, tasks } = createRecorder();

    const result = await reportProviderStatus({
      reporter,
      ports: {
        checkCredentials: () =>
          Promise.resolve({ ok: false, remediation: "run auth login" }),
      },
    });

    expect(result).toEqual({ connected: false });
    expect(methods(tasks)).toEqual(["startTask", "succeed"]);
    expect(tasks[1]?.message).toBe(PROVIDER_MISSING_LABEL);
    expect(methods(calls)).toEqual(["info"]);
    expect(messages(calls)).toEqual([PROVIDER_NOTICE_MESSAGE]);
  });

  test("surfaces a failed check rather than reporting no provider", async () => {
    const { reporter, calls, tasks } = createRecorder();
    const boom = new Error("EACCES");

    let caught: Error | null = null;
    try {
      await reportProviderStatus({
        reporter,
        ports: { checkCredentials: () => Promise.reject(boom) },
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBe(boom);
    expect(methods(tasks)).toEqual(["startTask", "fail"]);
    expect(messages(calls)).not.toContain(PROVIDER_NOTICE_MESSAGE);
  });
});
