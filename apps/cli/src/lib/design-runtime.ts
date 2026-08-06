import {
  ensureHostOpencodePayload,
  resolveHostOpencodeBinary,
  type OpencodePayloadProvisionProgress,
} from "@boboddy/worker";
import type { BaseReporter, WorkTask } from "./reporter-types";

/**
 * Provisioning the host-native OpenCode runtime for `pipelines design`, with
 * the progress reporting and error framing that a ~100 MB first-run download
 * needs.
 *
 * A silent multi-minute pause is the single worst thing this command could do
 * to a first-time user, so the download is always narrated: what is being
 * fetched, that it happens once, and how big it is.
 */

const BYTES_PER_MIB = 1024 * 1024;

/** Env var that pins the runtime version, surfaced in the failure message. */
const RUNTIME_VERSION_ENV = "BOBODDY_OPENCODE_RUNTIME_VERSION";

function formatMib(bytes: number): string {
  return (bytes / BYTES_PER_MIB).toFixed(0);
}

/**
 * Render provisioning progress onto a reporter task.
 *
 * Only a real download opens a task; a cache hit stays silent so the common
 * case doesn't flash a spinner. Returns the listener plus resolve helpers, so
 * the caller can close the task on both the success and failure paths.
 */
export function createRuntimeProgressRenderer(reporter: BaseReporter): {
  onProgress: (event: OpencodePayloadProvisionProgress) => void;
  succeed: () => void;
  fail: () => void;
} {
  let task: WorkTask | undefined;

  const onProgress = (event: OpencodePayloadProvisionProgress): void => {
    switch (event.phase) {
      case "provision-start": {
        task = reporter.startTask(
          "Fetching the AI runtime (one-time download, ~100 MB)…",
        );
        break;
      }
      case "platform-progress": {
        const received = formatMib(event.receivedBytes);
        const total =
          event.totalBytes === null ? null : formatMib(event.totalBytes);
        task?.update(
          total === null
            ? `Fetching the AI runtime… ${received} MB`
            : `Fetching the AI runtime… ${received}/${total} MB`,
        );
        break;
      }
      case "provision-done": {
        task?.succeed("AI runtime ready");
        task = undefined;
        break;
      }
      default:
        break;
    }
  };

  return {
    onProgress,
    succeed: () => {
      task?.succeed("AI runtime ready");
      task = undefined;
    },
    fail: () => {
      task?.fail("Could not fetch the AI runtime");
      task = undefined;
    },
  };
}

/**
 * Wrap a provisioning failure with the two things that actually unblock people:
 * corporate proxies (by far the most common cause) and the version pin escape
 * hatch when a specific release is unavailable.
 */
export function describeRuntimeProvisionFailure(cause: string): string {
  return [
    `Could not download the AI runtime: ${cause}`,
    "",
    "If you are behind a corporate proxy, set HTTPS_PROXY (and NO_PROXY for",
    "internal hosts) before re-running, or point the CLI at an internal npm",
    "mirror. To pin a different runtime release, set",
    `${RUNTIME_VERSION_ENV}=<version>.`,
  ].join("\n");
}

export type EnsureDesignRuntimeInput = {
  reporter: BaseReporter;
  /** Injected provisioning seam (tests). */
  ensurePayload?: typeof ensureHostOpencodePayload | undefined;
};

/**
 * Provision the runtime and return the absolute path of its `launch.sh`.
 * Throws an error already phrased for the user.
 */
export async function ensureDesignRuntime(
  input: EnsureDesignRuntimeInput,
): Promise<string> {
  const ensurePayload = input.ensurePayload ?? ensureHostOpencodePayload;
  const progress = createRuntimeProgressRenderer(input.reporter);

  try {
    const payload = await ensurePayload({ onProgress: progress.onProgress });
    progress.succeed();
    return resolveHostOpencodeBinary(payload);
  } catch (error) {
    progress.fail();
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(describeRuntimeProvisionFailure(cause));
  }
}
