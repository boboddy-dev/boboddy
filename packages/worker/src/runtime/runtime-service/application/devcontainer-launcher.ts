import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type { AnyJsonObject } from "../../../common/contracts/json";

export type ResolveDevcontainerConfigInput = {
  workspacePath: string;
};

/**
 * A progress update emitted while the devcontainer CLI runs, parsed from the
 * CLI's `--log-format json` stream so the user sees real activity during the
 * long create/up phase instead of a static, seemingly-frozen spinner.
 *
 * Two kinds:
 *  - `milestone`: a high-level lifecycle phase (e.g. "Running the
 *    postCreateCommand…"). The reporter uses these as the primary status line.
 *  - `detail`: a lower-level log line (a subprocess `Run: …` or its captured
 *    output). The reporter shows a rolling window of these *beneath* the
 *    current milestone, like streamed sub-logs.
 */
export type DevcontainerLaunchProgress = {
  kind: "milestone" | "detail";
  /** The text to show (phase label for milestones, log line for details). */
  phase: string;
};

export type LaunchDevcontainerInput = {
  sessionId: UuidV7;
  projectId: UuidV7;
  requestedByUserId: UuidV7;
  workspacePath: string;
  devcontainerConfigPath: string;
  /**
   * Optional callback invoked as the CLI streams progress. Lets the caller
   * update a spinner/log with the current phase. Best-effort and non-fatal:
   * unparseable lines are ignored.
   */
  onProgress?: ((progress: DevcontainerLaunchProgress) => void) | undefined;
};

export type LaunchDevcontainerResult = {
  containerId: string;
  metadata?: AnyJsonObject | undefined;
};

export type DevcontainerLauncher = {
  resolveConfigPath(
    input: ResolveDevcontainerConfigInput,
  ): Promise<string>;
  launch(input: LaunchDevcontainerInput): Promise<LaunchDevcontainerResult>;
  stop(containerId: string): Promise<void>;
};
