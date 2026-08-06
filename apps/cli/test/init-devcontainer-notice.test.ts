import { describe, expect } from "bun:test";
import {
  DEVCONTAINER_NOTICE_MESSAGE,
  DEVCONTAINER_PRESENT_LABEL,
  DEVCONTAINER_MISSING_LABEL,
  DEVCONTAINER_TASK_LABEL,
  reportDevcontainerStatus,
} from "../src/lib/init-devcontainer-notice";
import {
  concurrentTest as test,
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
  reportedMethods as methods,
} from "./utils";

/**
 * The devcontainer step of `boboddy init`.
 *
 * This step used to throw, which aborted `init` before the designer handoff — so
 * the one thing that can now author a devcontainer was unreachable for exactly
 * the repositories that needed it. It is a notice, and the tests that matter are
 * the ones proving it cannot go back to being a hard stop.
 */

describe("reportDevcontainerStatus", () => {
  test("reports a present devcontainer as a resolved task", async () => {
    const { reporter, calls, tasks } = createRecorder();

    const result = await reportDevcontainerStatus({
      reporter,
      ports: { hasDevcontainer: () => Promise.resolve(true) },
    });

    expect(result).toEqual({ present: true });
    expect(tasks[0]?.message).toBe(DEVCONTAINER_TASK_LABEL);
    expect(methods(tasks)).toEqual(["startTask", "succeed"]);
    expect(tasks[1]?.message).toBe(DEVCONTAINER_PRESENT_LABEL);
    // Nothing to caution about when one already exists.
    expect(methods(calls)).not.toContain("warn");
  });

  test("a missing devcontainer resolves the task and warns", async () => {
    const { reporter, calls, tasks } = createRecorder();

    const result = await reportDevcontainerStatus({
      reporter,
      ports: { hasDevcontainer: () => Promise.resolve(false) },
    });

    expect(result).toEqual({ present: false });
    // `succeed`, never `fail`: init did its job: it looked, and it is telling
    // the user what it found. A failed task reads like a blocked install.
    expect(methods(tasks)).toEqual(["startTask", "succeed"]);
    expect(tasks[1]?.message).toBe(DEVCONTAINER_MISSING_LABEL);
    expect(messages(calls)).toContain(DEVCONTAINER_NOTICE_MESSAGE);
  });

  test("never throws when the devcontainer is missing", async () => {
    // The regression that matters. A throw here aborts `init` before the
    // designer handoff, which is the only thing that can author a devcontainer.
    const { reporter } = createRecorder();

    let threw = false;
    try {
      await reportDevcontainerStatus({
        reporter,
        ports: { hasDevcontainer: () => Promise.resolve(false) },
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  test("the notice sends the user to the design session, not to a text editor", () => {
    // The point of softening the gate: the user is not being asked to go and
    // hand-write a devcontainer before they may continue.
    expect(DEVCONTAINER_NOTICE_MESSAGE).toContain("pipelines design");
    expect(DEVCONTAINER_NOTICE_MESSAGE).toContain(
      ".devcontainer/devcontainer.json",
    );
    expect(DEVCONTAINER_NOTICE_MESSAGE).not.toMatch(/re-run `boboddy init`/u);
  });

  test("surfaces a failed check rather than swallowing it", async () => {
    // A missing devcontainer is a notice; an unreadable filesystem is not, and
    // must not be reported as "no devcontainer".
    const { reporter, tasks } = createRecorder();
    const boom = new Error("EIO");

    let caught: Error | null = null;
    try {
      await reportDevcontainerStatus({
        reporter,
        ports: { hasDevcontainer: () => Promise.reject(boom) },
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBe(boom);
    expect(methods(tasks)).toEqual(["startTask", "fail"]);
  });
});
