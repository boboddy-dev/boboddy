import { describe, expect, test } from "bun:test";
import {
  createRuntimeProgressRenderer,
  describeRuntimeProvisionFailure,
  ensureDesignRuntime,
} from "../src/lib/design-runtime";
import type { BaseReporter, WorkTask } from "../src/lib/reporter-types";
import { noopBaseReporter } from "../src/lib/reporter-types";

/**
 * The first run of `pipelines design` downloads ~100 MB. A silent pause there
 * looks like a hang, and an unexplained failure there is unrecoverable for
 * anyone behind a corporate proxy — so both paths are pinned.
 */

type Recorded = { messages: string[]; started: string[]; outcome?: string };

function recordingReporter(): { reporter: BaseReporter; recorded: Recorded } {
  const recorded: Recorded = { messages: [], started: [] };
  const task: WorkTask = {
    update: (message) => {
      recorded.messages.push(message);
    },
    succeed: (message) => {
      recorded.outcome = `succeed:${message ?? ""}`;
    },
    fail: (message) => {
      recorded.outcome = `fail:${message ?? ""}`;
    },
  };

  return {
    reporter: {
      ...noopBaseReporter,
      startTask: (message: string) => {
        recorded.started.push(message);
        return task;
      },
    },
    recorded,
  };
}

describe("createRuntimeProgressRenderer", () => {
  test("announces the one-time download when provisioning starts", () => {
    const { reporter, recorded } = recordingReporter();
    const renderer = createRuntimeProgressRenderer(reporter);

    renderer.onProgress({
      phase: "provision-start",
      version: "1.18.11",
      platforms: ["darwin-arm64"],
    });

    expect(recorded.started).toHaveLength(1);
    expect(recorded.started[0]).toContain("one-time");
    expect(recorded.started[0]).toContain("MB");
  });

  test("stays silent on a cache hit", () => {
    // The common case must not flash a spinner for a no-op.
    const { reporter, recorded } = recordingReporter();
    const renderer = createRuntimeProgressRenderer(reporter);

    renderer.onProgress({ phase: "cache-hit", version: "1.18.11" });
    renderer.succeed();

    expect(recorded.started).toEqual([]);
    expect(recorded.outcome).toBeUndefined();
  });

  test("renders received/total megabytes while downloading", () => {
    const { reporter, recorded } = recordingReporter();
    const renderer = createRuntimeProgressRenderer(reporter);

    renderer.onProgress({
      phase: "provision-start",
      version: "1.18.11",
      platforms: ["darwin-arm64"],
    });
    renderer.onProgress({
      phase: "platform-progress",
      version: "1.18.11",
      platform: "darwin-arm64",
      receivedBytes: 25 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
    });

    expect(recorded.messages.at(-1)).toContain("25/100 MB");
  });

  test("copes with a registry that sends no content-length", () => {
    const { reporter, recorded } = recordingReporter();
    const renderer = createRuntimeProgressRenderer(reporter);

    renderer.onProgress({
      phase: "provision-start",
      version: "1.18.11",
      platforms: ["darwin-arm64"],
    });
    renderer.onProgress({
      phase: "platform-progress",
      version: "1.18.11",
      platform: "darwin-arm64",
      receivedBytes: 7 * 1024 * 1024,
      totalBytes: null,
    });

    expect(recorded.messages.at(-1)).toContain("7 MB");
    expect(recorded.messages.at(-1)).not.toContain("/");
  });
});

describe("describeRuntimeProvisionFailure", () => {
  test("keeps the cause and adds the two things that actually unblock people", () => {
    const message = describeRuntimeProvisionFailure("ECONNREFUSED registry");

    expect(message).toContain("ECONNREFUSED registry");
    expect(message).toContain("HTTPS_PROXY");
    expect(message).toContain("BOBODDY_OPENCODE_RUNTIME_VERSION");
  });
});

describe("ensureDesignRuntime", () => {
  test("returns the launch wrapper path for a provisioned payload", async () => {
    const launcher = await ensureDesignRuntime({
      reporter: noopBaseReporter,
      ensurePayload: () =>
        Promise.resolve({
          version: "1.18.11",
          hostPayloadDir: "/home/u/.boboddy/runtimes/opencode/1.18.11",
          containerPayloadDir: "/opt/boboddy/runtimes/opencode/1.18.11",
          containerLaunchWrapperPath:
            "/opt/boboddy/runtimes/opencode/1.18.11/launch.sh",
        }),
    });

    expect(launcher).toBe(
      "/home/u/.boboddy/runtimes/opencode/1.18.11/launch.sh",
    );
  });

  test("wraps a download failure and closes the progress task", async () => {
    const { reporter, recorded } = recordingReporter();

    let thrown: Error | undefined;
    try {
      await ensureDesignRuntime({
        reporter,
        ensurePayload: (options) => {
          options?.onProgress?.({
            phase: "provision-start",
            version: "1.18.11",
            platforms: ["darwin-arm64"],
          });
          return Promise.reject(new Error("socket hang up"));
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error : undefined;
    }

    expect(thrown?.message).toContain("socket hang up");
    expect(thrown?.message).toContain("HTTPS_PROXY");
    // A dangling spinner would leave the terminal in a broken state.
    expect(recorded.outcome).toContain("fail:");
  });
});
