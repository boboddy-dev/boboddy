/**
 * Thin wrappers around {@link TaskRunTracker} used by
 * `process-claimed-task.ts`. Split out purely to keep that module
 * under the repo's per-file line limit — no behavior lives here beyond what
 * the tracker interface itself already describes.
 */
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import { buildRunningMetadata } from "./process-claimed-task-helpers";
import type { TaskRunTracker } from "../contracts/process-project-work-types";

export async function createTrackedSession(
  tracker: TaskRunTracker,
  input: {
    localRuntimeSessionId: UuidV7;
    projectId: UuidV7;
    taskId: UuidV7;
  },
) {
  await tracker.createSession({
    id: input.localRuntimeSessionId,
    projectId: input.projectId,
    taskId: input.taskId,
  });
}

export async function markTrackedSessionRunning(
  tracker: TaskRunTracker,
  input: {
    localRuntimeSessionId: UuidV7;
    workspacePath: string;
    runtimeContainerId: string | null;
    agentBaseUrl: string | null;
    resolvedBranch: string;
    devcontainerConfigPath: string;
    aiImage: string;
    networkName: string;
  },
) {
  await tracker.markRunning({
    id: input.localRuntimeSessionId,
    workspacePath: input.workspacePath,
    runtimeContainerId: input.runtimeContainerId,
    agentBaseUrl: input.agentBaseUrl,
    metadataJson: buildRunningMetadata({
      resolvedBranch: input.resolvedBranch,
      devcontainerConfigPath: input.devcontainerConfigPath,
      aiImage: input.aiImage,
      networkName: input.networkName,
    }),
  });
}

export async function markTrackedSessionFailed(
  tracker: TaskRunTracker,
  input: {
    localRuntimeSessionId: UuidV7;
    failureReason: string;
    metadataJson?: string | undefined;
  },
) {
  await tracker.markFailed({
    id: input.localRuntimeSessionId,
    failureReason: input.failureReason,
    metadataJson: input.metadataJson,
  });
}

export async function attachTrackedAgentSession(
  tracker: TaskRunTracker,
  localRuntimeSessionId: UuidV7,
  agentSessionId: string,
) {
  await tracker.attachAgentSession({
    id: localRuntimeSessionId,
    agentSessionId,
  });
}
