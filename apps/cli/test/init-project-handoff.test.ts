import { describe, expect } from "bun:test";
import {
  HANDOFF_POLL_INTERVAL_MS,
  HANDOFF_TIMEOUT_MS,
  HANDOFF_WAITING_MESSAGE,
  handoffTimedOutMessage,
  nonInteractiveHandoffMessage,
  runProjectHandoff,
  type ProjectHandoffPorts,
} from "../src/lib/init-project-handoff";
import { CliError } from "../src/lib/cli-error";
import {
  concurrentTest as test,
  createReporterRecorder as createRecorder,
  reportedMessages as messages,
} from "./utils";

/**
 * `init`'s browser hand-off (#141): when no project matches the detected git
 * remote and it could not be created through the API, `init` opens
 * `/projects/new` and polls for the project. These pin the loop against a fake
 * clock: found on the Nth poll, Enter cutting a wait short, the timeout, and
 * refusing to wait at all without a terminal.
 */

const URL =
  "https://app.boboddy.dev/projects/new?gitUrl=git%40github.com%3Aacme%2Fmy-repo.git&name=my-repo&source=cli";

/**
 * Fake ports over a virtual clock. `wakeups` scripts what each wait resolves
 * with ("timer" advances the clock by the requested delay, "enter" by 0);
 * `foundOnCheck` is the 1-based check that finds the project.
 */
function fakePorts(input: {
  foundOnCheck?: number;
  wakeups?: Array<"timer" | "enter">;
  openBrowser?: ProjectHandoffPorts["openBrowser"];
}) {
  let clock = 0;
  const log: string[] = [];
  const waits: number[] = [];
  let checks = 0;
  let closed = 0;
  const wakeups = [...(input.wakeups ?? [])];

  const ports: ProjectHandoffPorts = {
    openBrowser:
      input.openBrowser ??
      ((url) => {
        log.push(`open:${url}`);
        return Promise.resolve();
      }),
    checkForProject: () => {
      checks += 1;
      log.push(`check@${String(clock)}`);
      return Promise.resolve(
        checks === input.foundOnCheck
          ? { projectId: "project-123" }
          : undefined,
      );
    },
    startCheckTrigger: () => ({
      wait: (delayMs) => {
        waits.push(delayMs);
        const wakeup = wakeups.shift() ?? "timer";
        if (wakeup === "timer") {
          clock += delayMs;
        }
        return Promise.resolve(wakeup);
      },
      close: () => {
        closed += 1;
      },
    }),
    now: () => clock,
  };

  return {
    ports,
    log,
    waits,
    checks: () => checks,
    closed: () => closed,
  };
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("runProjectHandoff", () => {
  test("opens the browser, then polls every interval until the project exists", async () => {
    const { reporter, tasks } = createRecorder();
    const fake = fakePorts({ foundOnCheck: 3 });

    const result = await runProjectHandoff({
      interactive: true,
      reporter,
      url: URL,
      ports: fake.ports,
    });

    expect(result).toEqual({ projectId: "project-123" });
    expect(fake.log).toEqual([
      `open:${URL}`,
      "check@0",
      `check@${String(HANDOFF_POLL_INTERVAL_MS)}`,
      `check@${String(HANDOFF_POLL_INTERVAL_MS * 2)}`,
    ]);
    expect(fake.waits).toEqual([
      HANDOFF_POLL_INTERVAL_MS,
      HANDOFF_POLL_INTERVAL_MS,
    ]);
    expect(tasks).toEqual([
      { method: "startTask", message: HANDOFF_WAITING_MESSAGE },
      { method: "succeed", message: "Project created and linked" },
    ]);
    expect(fake.closed()).toBe(1);
  });

  test("pressing Enter checks immediately instead of waiting out the interval", async () => {
    const { reporter } = createRecorder();
    const fake = fakePorts({ foundOnCheck: 2, wakeups: ["enter"] });

    const result = await runProjectHandoff({
      interactive: true,
      reporter,
      url: URL,
      ports: fake.ports,
    });

    expect(result).toEqual({ projectId: "project-123" });
    expect(fake.log).toEqual([`open:${URL}`, "check@0", "check@0"]);
  });

  test("gives up with project_handoff_unresolved once the timeout passes", async () => {
    const { reporter, tasks } = createRecorder();
    const fake = fakePorts({});

    const error = await catchError(
      runProjectHandoff({
        interactive: true,
        reporter,
        url: URL,
        ports: fake.ports,
        pollIntervalMs: 1_000,
        timeoutMs: 2_500,
      }),
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("project_handoff_unresolved");
    expect((error as CliError).message).toBe(
      handoffTimedOutMessage(URL, 2_500),
    );
    expect(fake.waits).toEqual([1_000, 1_000, 500]);
    expect(fake.checks()).toBe(4);
    expect(tasks.at(-1)).toEqual({
      method: "fail",
      message: "No project found for this repository",
    });
    expect(fake.closed()).toBe(1);
  });

  test("the default timeout is 15 minutes", () => {
    expect(HANDOFF_TIMEOUT_MS).toBe(15 * 60 * 1_000);
    expect(handoffTimedOutMessage(URL, HANDOFF_TIMEOUT_MS)).toContain(
      "after 15 minutes",
    );
  });

  test("degrades to a manual-open warning when openBrowser throws, but still polls", async () => {
    const { reporter, calls } = createRecorder();
    const fake = fakePorts({
      foundOnCheck: 1,
      openBrowser: () => Promise.reject(new Error("no display")),
    });

    const result = await runProjectHandoff({
      interactive: true,
      reporter,
      url: URL,
      ports: fake.ports,
    });

    expect(result).toEqual({ projectId: "project-123" });
    expect(messages(calls)).toContain(
      "Could not open a browser automatically. Open the URL above manually.",
    );
  });

  test("throws project_handoff_noninteractive without opening, polling, or listening", async () => {
    const { reporter } = createRecorder();
    let opened = 0;
    let triggers = 0;
    const fake = fakePorts({ foundOnCheck: 1 });

    const error = await catchError(
      runProjectHandoff({
        interactive: false,
        reporter,
        url: URL,
        ports: {
          ...fake.ports,
          openBrowser: () => {
            opened += 1;
            return Promise.resolve();
          },
          startCheckTrigger: () => {
            triggers += 1;
            return fake.ports.startCheckTrigger();
          },
        },
      }),
    );

    expect((error as CliError).code).toBe("project_handoff_noninteractive");
    expect((error as CliError).message).toBe(nonInteractiveHandoffMessage(URL));
    expect(opened).toBe(0);
    expect(triggers).toBe(0);
    expect(fake.checks()).toBe(0);
  });

  test("propagates a failed check (e.g. the project list cannot load) and stops listening", async () => {
    const { reporter } = createRecorder();
    const boom = new Error("Could not load your projects (HTTP 500).");
    const fake = fakePorts({});

    const error = await catchError(
      runProjectHandoff({
        interactive: true,
        reporter,
        url: URL,
        ports: { ...fake.ports, checkForProject: () => Promise.reject(boom) },
      }),
    );

    expect(error).toBe(boom);
    expect(fake.closed()).toBe(1);
  });
});
