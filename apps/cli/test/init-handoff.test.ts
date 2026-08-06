import { describe, expect } from "bun:test";
import {
  DESIGN_LAUNCH_MESSAGE,
  DESIGN_NEXT_STEP_MESSAGE,
  runInitHandoff,
} from "../src/lib/init-handoff";
import {
  concurrentTest,
  createReporterRecorder as createRecorder,
} from "./utils";

/**
 * The epilogue of `boboddy init`. The behavior that matters does not involve a
 * terminal: the handoff must close the reporter block before the designer takes
 * over the tty.
 */

describe("runInitHandoff", () => {
  concurrentTest("prints the next step without prompting when non-interactive", async () => {
    const { reporter, calls } = createRecorder();
    let confirmed = 0;
    let launched = 0;

    const result = await runInitHandoff({
      interactive: false,
      reporter,
      ports: {
        confirmLaunch: () => {
          confirmed += 1;
          return Promise.resolve(true);
        },
        launchDesign: () => {
          launched += 1;
          return Promise.resolve();
        },
      },
    });

    expect(result.launched).toBe(false);
    expect(confirmed).toBe(0);
    expect(launched).toBe(0);
    expect(calls.map((call) => call.message)).toContain(
      DESIGN_NEXT_STEP_MESSAGE,
    );
  });

  concurrentTest("launches the designer when the user accepts", async () => {
    const { reporter, calls } = createRecorder();
    const order: string[] = [];

    const result = await runInitHandoff({
      interactive: true,
      reporter: {
        ...reporter,
        finish: (message) => {
          order.push(`finish:${message}`);
          reporter.finish(message);
        },
      },
      ports: {
        confirmLaunch: () => Promise.resolve(true),
        launchDesign: () => {
          order.push("launch");
          return Promise.resolve();
        },
      },
    });

    expect(result.launched).toBe(true);
    // The clack block must be closed before the TUI owns the terminal.
    expect(order).toEqual([`finish:${DESIGN_LAUNCH_MESSAGE}`, "launch"]);
    expect(calls.map((call) => call.message)).not.toContain(
      DESIGN_NEXT_STEP_MESSAGE,
    );
  });

  concurrentTest("prints the next step when the user declines", async () => {
    const { reporter, calls } = createRecorder();
    let launched = 0;

    const result = await runInitHandoff({
      interactive: true,
      reporter,
      ports: {
        confirmLaunch: () => Promise.resolve(false),
        launchDesign: () => {
          launched += 1;
          return Promise.resolve();
        },
      },
    });

    expect(result.launched).toBe(false);
    expect(launched).toBe(0);
    expect(calls.map((call) => call.message)).toContain(
      DESIGN_NEXT_STEP_MESSAGE,
    );
    expect(calls.at(-1)?.method).toBe("finish");
  });
});
