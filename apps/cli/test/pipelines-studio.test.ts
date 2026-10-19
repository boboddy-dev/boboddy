import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { PipelineStudioServerHandle } from "@boboddy/worker";
import {
  runStudioSession,
  type StudioSessionPorts,
} from "../src/commands/pipelines-studio";
import {
  concurrentTest,
  createReporterRecorder,
  reportedMessages,
  runCli,
} from "./utils";

// Spawns the CLI from source; under a loaded machine (test-all-workspaces)
// that overruns bun's 5s default.
setDefaultTimeout(15_000);

/**
 * `runStudioSession` is the whole command minus its I/O — every port here is
 * a fake, per the task's own instruction not to exercise a real
 * `Bun.serve`/browser-open in this file (that mechanism has its own,
 * genuinely real-server test: `packages/worker`'s
 * `run-pipeline-studio-server.test.ts`). This file is about ORDERING and
 * WIRING: preflight before serving, serving before opening a browser,
 * opening before waiting, closing only after the wait resolves.
 */

const HANDLE: PipelineStudioServerHandle = {
  url: "http://localhost:54321",
  close: () => Promise.resolve(),
};

type Calls = {
  scaffoldBuilderDir: number;
  startServer: { builderDir: string; port: number | undefined } | undefined;
  openBrowser: string | undefined;
  studioOpened: { browserOpened: boolean }[];
  waitForShutdownSignal: number;
  close: number;
};

function createPorts(overrides: Partial<StudioSessionPorts> = {}): {
  ports: StudioSessionPorts;
  calls: Calls;
} {
  const calls: Calls = {
    scaffoldBuilderDir: 0,
    startServer: undefined,
    openBrowser: undefined,
    studioOpened: [],
    waitForShutdownSignal: 0,
    close: 0,
  };

  const base: StudioSessionPorts = {
    builderDirExists: () => true,
    scaffoldBuilderDir: () => {
      calls.scaffoldBuilderDir += 1;
    },
    dependenciesInstalled: () => true,
    startServer: (input) => {
      calls.startServer = input;
      return Promise.resolve({
        url: HANDLE.url,
        close: () => {
          calls.close += 1;
          return Promise.resolve();
        },
      });
    },
    openBrowser: (url) => {
      calls.openBrowser = url;
      return Promise.resolve();
    },
    studioOpened: (input) => {
      calls.studioOpened.push(input);
    },
    waitForShutdownSignal: () => {
      calls.waitForShutdownSignal += 1;
      return Promise.resolve();
    },
  };

  return { ports: { ...base, ...overrides }, calls };
}

describe("runStudioSession — orchestration", () => {
  test("runs the preflight, starts the server, opens the browser, waits, then closes", async () => {
    const { ports, calls } = createPorts();
    const { reporter } = createReporterRecorder();

    await runStudioSession({
      builderDir: "/repo/.boboddy/pipeline-builder",
      port: 4000,
      reporter,
      ports,
    });

    expect(calls.startServer).toEqual({
      builderDir: "/repo/.boboddy/pipeline-builder",
      port: 4000,
    });
    expect(calls.openBrowser).toBe(HANDLE.url);
    expect(calls.waitForShutdownSignal).toBe(1);
    expect(calls.close).toBe(1);
  });

  test("scaffolds the builder directory before starting the server", async () => {
    const { ports, calls } = createPorts({ builderDirExists: () => false });
    const { reporter } = createReporterRecorder();

    await runStudioSession({
      builderDir: "/repo/.boboddy/pipeline-builder",
      port: undefined,
      reporter,
      ports,
    });

    expect(calls.scaffoldBuilderDir).toBe(1);
    expect(calls.startServer).not.toBeUndefined();
  });

  test("fails before starting a server when dependencies are missing", async () => {
    const { ports, calls } = createPorts({ dependenciesInstalled: () => false });
    const { reporter } = createReporterRecorder();

    let thrown: unknown;
    try {
      await runStudioSession({
        builderDir: "/repo/.boboddy/pipeline-builder",
        port: undefined,
        reporter,
        ports,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Missing dependencies");
    expect(calls.startServer).toBeUndefined();
    expect(calls.waitForShutdownSignal).toBe(0);
  });

  test("a failing browser open is a warning, not a fatal error — the session keeps running", async () => {
    const { ports, calls } = createPorts({
      openBrowser: () => Promise.reject(new Error("no display")),
    });
    const { reporter, calls: reported } = createReporterRecorder();

    await runStudioSession({
      builderDir: "/repo/.boboddy/pipeline-builder",
      port: undefined,
      reporter,
      ports,
    });

    expect(calls.waitForShutdownSignal).toBe(1);
    expect(calls.close).toBe(1);
    expect(
      reportedMessages(reported).some((message) =>
        message.includes("Could not open a browser"),
      ),
    ).toBe(true);
  });

  test("records the studio as opened with the browser after a successful open", async () => {
    const { ports, calls } = createPorts();
    const { reporter } = createReporterRecorder();

    await runStudioSession({
      builderDir: "/repo/.boboddy/pipeline-builder",
      port: undefined,
      reporter,
      ports,
    });

    expect(calls.studioOpened).toEqual([{ browserOpened: true }]);
  });

  test("records the studio as opened without a browser when the open fails", async () => {
    const { ports, calls } = createPorts({
      openBrowser: () => Promise.reject(new Error("no display")),
    });
    const { reporter } = createReporterRecorder();

    await runStudioSession({
      builderDir: "/repo/.boboddy/pipeline-builder",
      port: undefined,
      reporter,
      ports,
    });

    expect(calls.studioOpened).toEqual([{ browserOpened: false }]);
  });

  test("does not record the studio as opened when the preflight fails", async () => {
    const { ports, calls } = createPorts({ dependenciesInstalled: () => false });
    const { reporter } = createReporterRecorder();

    await runStudioSession({
      builderDir: "/repo/.boboddy/pipeline-builder",
      port: undefined,
      reporter,
      ports,
    }).catch(() => undefined);

    expect(calls.studioOpened).toEqual([]);
  });

  test("reports the server's URL so a user without a browser can still open it", async () => {
    const { ports } = createPorts();
    const { reporter, calls: reported } = createReporterRecorder();

    await runStudioSession({
      builderDir: "/repo/.boboddy/pipeline-builder",
      port: undefined,
      reporter,
      ports,
    });

    expect(
      reportedMessages(reported).some((message) => message.includes(HANDLE.url)),
    ).toBe(true);
  });
});

// ─── Command wiring — spawns the real CLI, mirroring pipelines.test.ts ──────

describe("boboddy pipelines studio — command wiring", () => {
  concurrentTest("is listed under `pipelines --help`", async () => {
    const result = await runCli(["pipelines", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("studio");
  });

  concurrentTest("studio --help shows its --port option", async () => {
    const result = await runCli(["pipelines", "studio", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--port");
  });

  concurrentTest("rejects unknown options (strict mode)", async () => {
    const result = await runCli(["pipelines", "studio", "--nope"]);

    expect(result.exitCode).toBe(1);
  });
});
