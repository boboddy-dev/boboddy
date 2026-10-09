import { describe, expect, test } from "bun:test";
import {
  STUDIO_UNAVAILABLE_MESSAGE,
  startDesignStudio,
  type DesignStudioPorts,
} from "../src/lib/design-studio";
import { createReporterRecorder, reportedMessages } from "./utils";

/**
 * `startDesignStudio` is the design session's non-fatal studio companion.
 * Every port is a fake: the real server has its own test in
 * `packages/worker`'s `run-pipeline-studio-server.test.ts`. These tests pin
 * the contract that no studio failure ever escapes to the caller.
 */

const STUDIO_URL = "http://localhost:54321";
const BUILDER_DIR = "/repo/.boboddy/pipeline-builder";

type Calls = {
  startServer: { builderDir: string } | undefined;
  openBrowser: string | undefined;
  close: number;
};

function createPorts(overrides: Partial<DesignStudioPorts> = {}): {
  ports: DesignStudioPorts;
  calls: Calls;
} {
  const calls: Calls = {
    startServer: undefined,
    openBrowser: undefined,
    close: 0,
  };

  const base: DesignStudioPorts = {
    startServer: (input) => {
      calls.startServer = input;
      return Promise.resolve({
        url: STUDIO_URL,
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
  };

  return { ports: { ...base, ...overrides }, calls };
}

describe("startDesignStudio", () => {
  test.concurrent(
    "starts the server, opens the browser, and reports the URL",
    async () => {
      const { ports, calls } = createPorts();
      const { reporter, tasks } = createReporterRecorder();

      const handle = await startDesignStudio({
        builderDir: BUILDER_DIR,
        reporter,
        ports,
      });

      expect(handle?.url).toBe(STUDIO_URL);
      expect(handle?.browserOpened).toBe(true);
      expect(calls.startServer).toEqual({ builderDir: BUILDER_DIR });
      expect(calls.openBrowser).toBe(STUDIO_URL);
      expect(tasks).toContainEqual({
        method: "succeed",
        message: `Studio running at ${STUDIO_URL}`,
      });

      await handle?.close();
      expect(calls.close).toBe(1);
    },
  );

  test.concurrent(
    "returns null and continues without the studio when the server fails to start",
    async () => {
      const { ports, calls } = createPorts({
        startServer: () => Promise.reject(new Error("port in use")),
      });
      const { reporter, calls: reported, tasks } = createReporterRecorder();

      const handle = await startDesignStudio({
        builderDir: BUILDER_DIR,
        reporter,
        ports,
      });

      expect(handle).toBeNull();
      expect(calls.openBrowser).toBeUndefined();
      expect(tasks).toContainEqual({
        method: "fail",
        message: "Could not start the pipeline studio",
      });
      expect(reported).toContainEqual({
        method: "warn",
        message: "port in use",
      });
      expect(reported).toContainEqual({
        method: "info",
        message: STUDIO_UNAVAILABLE_MESSAGE,
      });
    },
  );

  test.concurrent(
    "returns a handle with browserOpened false and points at the URL when the browser fails to open",
    async () => {
      const { ports } = createPorts({
        openBrowser: () => Promise.reject(new Error("no display")),
      });
      const { reporter, calls: reported } = createReporterRecorder();

      const handle = await startDesignStudio({
        builderDir: BUILDER_DIR,
        reporter,
        ports,
      });

      expect(handle?.url).toBe(STUDIO_URL);
      expect(handle?.browserOpened).toBe(false);
      const warnings = reported
        .filter((call) => call.method === "warn")
        .map((call) => call.message);
      expect(warnings.some((message) => message.includes(STUDIO_URL))).toBe(
        true,
      );
      expect(
        reportedMessages(reported).some((message) =>
          message.includes("Could not open a browser"),
        ),
      ).toBe(true);
    },
  );

  test.concurrent("close() swallows a failing server close", async () => {
    const { ports } = createPorts({
      startServer: () =>
        Promise.resolve({
          url: STUDIO_URL,
          close: () => Promise.reject(new Error("already closed")),
        }),
    });
    const { reporter } = createReporterRecorder();

    const handle = await startDesignStudio({
      builderDir: BUILDER_DIR,
      reporter,
      ports,
    });

    expect(handle).not.toBeNull();
    expect(await handle?.close()).toBeUndefined();
  });
});
