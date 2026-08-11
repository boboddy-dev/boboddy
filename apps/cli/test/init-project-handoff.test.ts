import { describe, expect } from "bun:test";
import {
  HANDOFF_INSTRUCTIONS_MESSAGE,
  nonInteractiveHandoffMessage,
  runProjectHandoff,
} from "../src/lib/init-project-handoff";
import {
  concurrentTest as test,
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
} from "./utils";

/**
 * `init`'s browser hand-off (#141): when no project matches the detected git
 * remote, `init` opens `/projects/new` and waits for a keypress instead of
 * silently `POST`-ing a project. v1 is manual — no polling, no deep link — so
 * the only branching that matters here is: did we open the browser, did we
 * wait, and did we refuse to wait forever with no terminal to wait on.
 */

const URL =
  "https://app.boboddy.dev/projects/new?gitUrl=git%40github.com%3Aacme%2Fmy-repo.git&name=my-repo";

describe("runProjectHandoff", () => {
  test("opens the browser, waits for a keypress, then resolves via completeHandoff", async () => {
    const { reporter, calls } = createRecorder();
    const order: string[] = [];

    const result = await runProjectHandoff({
      interactive: true,
      reporter,
      url: URL,
      ports: {
        openBrowser: (url) => {
          order.push(`open:${url}`);
          return Promise.resolve();
        },
        waitForKeypress: () => {
          order.push("wait");
          return Promise.resolve();
        },
        completeHandoff: () => {
          order.push("complete");
          return Promise.resolve({ projectId: "project-123" });
        },
      },
    });

    expect(result).toEqual({ projectId: "project-123" });
    expect(order).toEqual([`open:${URL}`, "wait", "complete"]);
    expect(messages(calls)).toContain(HANDOFF_INSTRUCTIONS_MESSAGE);
  });

  test("degrades to a manual-open warning when openBrowser throws, but still waits and completes", async () => {
    const { reporter, calls } = createRecorder();
    let waited = 0;

    const result = await runProjectHandoff({
      interactive: true,
      reporter,
      url: URL,
      ports: {
        openBrowser: () => Promise.reject(new Error("no display")),
        waitForKeypress: () => {
          waited += 1;
          return Promise.resolve();
        },
        completeHandoff: () => Promise.resolve({ projectId: "project-123" }),
      },
    });

    expect(result).toEqual({ projectId: "project-123" });
    expect(waited).toBe(1);
    expect(messages(calls)).toContain(
      "Could not open a browser automatically. Open the URL above manually.",
    );
  });

  test("throws instead of blocking on stdin when there is no interactive terminal", async () => {
    const { reporter } = createRecorder();
    let opened = 0;
    let waited = 0;
    let completed = 0;

    let caught: Error | null = null;
    try {
      await runProjectHandoff({
        interactive: false,
        reporter,
        url: URL,
        ports: {
          openBrowser: () => {
            opened += 1;
            return Promise.resolve();
          },
          waitForKeypress: () => {
            waited += 1;
            return Promise.resolve();
          },
          completeHandoff: () => {
            completed += 1;
            return Promise.resolve({ projectId: "project-123" });
          },
        },
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught?.message).toBe(nonInteractiveHandoffMessage(URL));
    expect(opened).toBe(0);
    expect(waited).toBe(0);
    expect(completed).toBe(0);
  });

  test("propagates completeHandoff's failure (e.g. still no matching project) without swallowing it", async () => {
    const { reporter } = createRecorder();
    const boom = new Error("Still no project found for this repository.");

    let caught: Error | null = null;
    try {
      await runProjectHandoff({
        interactive: true,
        reporter,
        url: URL,
        ports: {
          openBrowser: () => Promise.resolve(),
          waitForKeypress: () => Promise.resolve(),
          completeHandoff: () => Promise.reject(boom),
        },
      });
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught).toBe(boom);
  });
});
