import { STEP_EXECUTION_AGENT } from "@boboddy/opencode-plugin";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { startProcessClaimedExecution } from "./process-claimed-step-execution";
import type { resolveProjectWorkLogger } from "./process-project-work-logger";
import type { ProcessProjectWorkDeps } from "../contracts/process-project-work-types";
import { buildFindingsSubmissionPath } from "./process-project-work-findings";
import { detectArtifactKind } from "../../../artifacts/artifact-store/domain/detect-artifact-kind";

const FINDINGS_RETRY_PROMPT = [
  "You finished without submitting Boboddy findings.",
  "Use the `boboddy-submit-step-findings` tool now.",
  "Write findings to `.boboddy/step-findings-submission.json`.",
  "Pass only `findingsJson`.",
  "The tool will load `.boboddy/current-execution/execution.json` and validate your findings against the stored schema.",
  "Do not end the task without calling that tool.",
].join(" ");

export type MissingFindingsState = {
  hasWaitedForSessionStop: boolean;
  hasRetriedFindingsSubmission: boolean;
  hasWaitedForRetriedFindingsSubmission: boolean;
};

export type MissingFindingsAction = "continue" | "throw";

export async function handleMissingFindings(
  deps: ProcessProjectWorkDeps,
  startedExecution: Awaited<ReturnType<typeof startProcessClaimedExecution>>,
  logger: ReturnType<typeof resolveProjectWorkLogger>,
  state: MissingFindingsState,
  stepStatus: string,
  workerId: string,
): Promise<MissingFindingsAction> {
  if (!state.hasWaitedForSessionStop) {
    const diagnostics = await captureMissingFindingsDiagnostics({
      workspacePath: startedExecution.environment.workspacePath,
      opencodeLogDirectory: startedExecution.environment.opencodeLogDirectory,
    });
    state.hasWaitedForSessionStop = true;
    logger.log(
      "worker",
      "OpenCode session stopped without findings submission; waiting one poll for late file writes before retrying",
      {
        projectId: startedExecution.projectId,
        workerId,
        stepExecutionId: startedExecution.stepExecutionId,
        localRuntimeSessionId: startedExecution.localRuntimeSessionId,
        status: stepStatus,
        agentSessionId: startedExecution.agentSessionId,
        findingsFile: diagnostics.findingsFile,
        currentExecutionFile: diagnostics.currentExecutionFile,
        opencodeLogs: diagnostics.opencodeLogs,
      },
    );
    return "continue";
  }

  if (!state.hasRetriedFindingsSubmission) {
    const diagnostics = await captureMissingFindingsDiagnostics({
      workspacePath: startedExecution.environment.workspacePath,
      opencodeLogDirectory: startedExecution.environment.opencodeLogDirectory,
    });
    state.hasRetriedFindingsSubmission = true;
    state.hasWaitedForRetriedFindingsSubmission = false;
    logger.log(
      "worker",
      "OpenCode session stopped without findings submission; sending one retry prompt",
      {
        projectId: startedExecution.projectId,
        workerId,
        stepExecutionId: startedExecution.stepExecutionId,
        localRuntimeSessionId: startedExecution.localRuntimeSessionId,
        status: stepStatus,
        agentSessionId: startedExecution.agentSessionId,
        findingsFile: diagnostics.findingsFile,
        currentExecutionFile: diagnostics.currentExecutionFile,
        opencodeLogs: diagnostics.opencodeLogs,
      },
    );
    await deps.agentRunner.sendRetryPrompt({
      agentBaseUrl: startedExecution.environment.agentBaseUrl,
      workspaceFolder: startedExecution.environment.workspaceFolder,
      sessionId: startedExecution.agentSessionId,
      promptText: FINDINGS_RETRY_PROMPT,
      agent: STEP_EXECUTION_AGENT,
    });
    return "continue";
  }

  if (!state.hasWaitedForRetriedFindingsSubmission) {
    const diagnostics = await captureMissingFindingsDiagnostics({
      workspacePath: startedExecution.environment.workspacePath,
      opencodeLogDirectory: startedExecution.environment.opencodeLogDirectory,
    });
    state.hasWaitedForRetriedFindingsSubmission = true;
    logger.log(
      "worker",
      "OpenCode retry prompt was accepted but findings are still missing; waiting one extra poll before failing",
      {
        projectId: startedExecution.projectId,
        workerId,
        stepExecutionId: startedExecution.stepExecutionId,
        localRuntimeSessionId: startedExecution.localRuntimeSessionId,
        status: stepStatus,
        agentSessionId: startedExecution.agentSessionId,
        findingsFile: diagnostics.findingsFile,
        currentExecutionFile: diagnostics.currentExecutionFile,
        opencodeLogs: diagnostics.opencodeLogs,
      },
    );
    return "continue";
  }

  return "throw";
}

export async function describeFile(filePath: string): Promise<{
  path: string;
  exists: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  contentPreview?: string;
}> {
  try {
    const fileStat = await stat(filePath);
    const rawContent = fileStat.isFile()
      ? // eslint-disable-next-line local/no-unknown-parameter-type
        await readFile(filePath, "utf8").catch((error: unknown) => {
          return `Failed to read file: ${error instanceof Error ? error.message : String(error)}`;
        })
      : undefined;

    return {
      path: filePath,
      exists: true,
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      contentPreview:
        rawContent && rawContent.length > 2000
          ? `${rawContent.slice(0, 2000)}\n...<truncated ${String(rawContent.length - 2000)} chars>`
          : rawContent,
    };
  } catch {
    return {
      path: filePath,
      exists: false,
    };
  }
}

export async function captureOpencodeLogPreview(logDirectory: string): Promise<
  Array<{
    file: string;
    contentPreview: string;
  }>
> {
  try {
    const entries = await readdir(logDirectory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
      .slice(-4);

    return await Promise.all(
      files.map(async (file) => {
        const rawContent = await readFile(path.join(logDirectory, file), "utf8").catch(
          // eslint-disable-next-line local/no-unknown-parameter-type
          (error: unknown) => {
            return `Failed to read log: ${error instanceof Error ? error.message : String(error)}`;
          },
        );

        return {
          file,
          contentPreview:
            rawContent.length > 2000
              ? `${rawContent.slice(0, 2000)}\n...<truncated ${String(rawContent.length - 2000)} chars>`
              : rawContent,
        };
      }),
    );
  } catch (error) {
    return [
      {
        file: "<opencode-log-dir>",
        contentPreview: `Unavailable: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}

export async function captureMissingFindingsDiagnostics(input: {
  workspacePath: string;
  opencodeLogDirectory: string;
}) {
  const findingsPath = buildFindingsSubmissionPath(input.workspacePath);
  const currentExecutionPath = path.join(
    input.workspacePath,
    ".boboddy",
    "current-execution",
    "execution.json",
  );

  return {
    findingsFile: await describeFile(findingsPath),
    currentExecutionFile: await describeFile(currentExecutionPath),
    opencodeLogs: await captureOpencodeLogPreview(input.opencodeLogDirectory),
  };
}

export async function collectStepArtifacts(
  deps: ProcessProjectWorkDeps,
  startedExecution: Awaited<ReturnType<typeof startProcessClaimedExecution>>,
  logger: ReturnType<typeof resolveProjectWorkLogger>,
): Promise<void> {
  const stepArtifactsDir = path.join(
    startedExecution.environment.workspacePath,
    ".boboddy",
    "step-artifacts",
  );

  try {
    await access(stepArtifactsDir);
  } catch {
    return;
  }

  const entries = await readdir(stepArtifactsDir, { recursive: true });

  for (const entry of entries) {
    const relativeStorePath = entry;
    const sourcePath = path.join(stepArtifactsDir, relativeStorePath);
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
      continue;
    }

    logger.log("worker", "Saving step artifact", {
      stepExecutionId: startedExecution.stepExecutionId,
      relativeStorePath,
      sourcePath,
    });

    const kind = detectArtifactKind(relativeStorePath);

    try {
      const result = await deps.artifactStore.saveArtifact({
        stepExecutionId: startedExecution.stepExecutionId,
        claimToken: startedExecution.claimToken,
        sourcePath,
        relativeStorePath,
        kind,
      });
      logger.log("worker", "Saved step artifact", {
        stepExecutionId: startedExecution.stepExecutionId,
        relativeStorePath,
        storeRef: result.storeRef,
        sizeBytes: result.sizeBytes,
      });
    } catch (error) {
      logger.error("worker", "Failed to save step artifact", {
        stepExecutionId: startedExecution.stepExecutionId,
        relativeStorePath,
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
