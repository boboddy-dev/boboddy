import { TASK_AGENT } from "@boboddy/opencode-plugin";
import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { startProcessClaimedTask } from "./process-claimed-task";
import type { resolveProjectWorkLogger } from "./process-project-work-logger";
import type { ProcessProjectWorkDeps } from "../contracts/process-project-work-types";
import { buildFindingsSubmissionPath } from "./process-project-work-findings";
import { resolveMonitorAgentContext } from "./process-project-work-monitor-agent";
import { toOpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";
import { detectArtifactKind } from "../../../artifacts/artifact-store/domain/detect-artifact-kind";
import { classifyArtifactSaveError } from "../../../artifacts/artifact-store/domain/classify-artifact-save-error";

const execFileAsync = promisify(execFile);

/**
 * Single-quote a value for safe interpolation into a `sh -c` command. Exported
 * so other modules building their own `docker exec ... sh -lc "..."` commands
 * (e.g. `execute-code-step.ts`) reuse this exact quoting idiom rather than
 * reimplementing it.
 */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Truncate content to 2000 chars, appending a truncation marker when clipped. */
function truncatePreview(rawContent: string): string {
  return rawContent.length > 2000
    ? `${rawContent.slice(0, 2000)}\n...<truncated ${String(rawContent.length - 2000)} chars>`
    : rawContent;
}

/**
 * Default docker-exec seam used by {@link captureOpencodeLogPreview}. Extracted
 * so unit tests can inject a fake and exercise the container branch without a
 * real Docker daemon.
 */
async function defaultRunDockerExec(
  args: string[],
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync("docker", args);
  return { stdout };
}

const FINDINGS_RETRY_PROMPT = [
  "You finished without submitting Boboddy findings.",
  "Use the `boboddy-submit-step-findings` tool now.",
  "Write findings to `.boboddy/step-findings-submission.json`.",
  "Pass only `findingsJson`.",
  "The tool will load `.boboddy/current-execution/execution.json` and validate your findings against the stored schema.",
  "Do not end the task without calling that tool.",
].join(" ");

/**
 * Progress through the missing-findings flow. `graceWaitedMs` is the poll
 * sleep time spent in the current grace window; the monitor adds to it after
 * every "continue" and this helper resets it when a new window opens.
 */
export type MissingFindingsState = {
  hasWaitedForSessionStop: boolean;
  hasRetriedFindingsSubmission: boolean;
  hasWaitedForRetriedFindingsSubmission: boolean;
  graceWaitedMs: number;
};

export type MissingFindingsAction = "continue" | "throw";

export async function handleMissingFindings(
  deps: ProcessProjectWorkDeps,
  startedTask: Awaited<ReturnType<typeof startProcessClaimedTask>>,
  logger: ReturnType<typeof resolveProjectWorkLogger>,
  state: MissingFindingsState,
  stepStatus: string,
  workerId: string,
  graceMs: number,
): Promise<MissingFindingsAction> {
  const agentContext = resolveMonitorAgentContext(startedTask);
  if (agentContext.mode !== "agent") {
    throw new Error(
      "Missing-findings retry handling is AI-only but the started execution has no agent",
    );
  }
  const { agent, agentSessionId } = agentContext;

  if (state.hasWaitedForSessionStop && state.graceWaitedMs < graceMs) {
    return "continue";
  }
  state.graceWaitedMs = 0;

  if (!state.hasWaitedForSessionStop) {
    const diagnostics = await captureMissingFindingsDiagnostics({
      workspacePath: startedTask.environment.workspacePath,
      opencodeLogDirectory: agent.logDirectory,
      runtimeContainerId: startedTask.environment.runtimeContainerId,
    });
    state.hasWaitedForSessionStop = true;
    logger.log(
      "worker",
      "OpenCode session stopped without findings submission; waiting for late file writes before retrying",
      {
        projectId: startedTask.projectId,
        workerId,
        taskId: startedTask.taskId,
        localRuntimeSessionId: startedTask.localRuntimeSessionId,
        status: stepStatus,
        agentSessionId,
        findingsFile: diagnostics.findingsFile,
        currentExecutionFile: diagnostics.currentExecutionFile,
        opencodeLogs: diagnostics.opencodeLogs,
      },
    );
    return "continue";
  }

  if (!state.hasRetriedFindingsSubmission) {
    const diagnostics = await captureMissingFindingsDiagnostics({
      workspacePath: startedTask.environment.workspacePath,
      opencodeLogDirectory: agent.logDirectory,
      runtimeContainerId: startedTask.environment.runtimeContainerId,
    });
    state.hasRetriedFindingsSubmission = true;
    state.hasWaitedForRetriedFindingsSubmission = false;
    logger.log(
      "worker",
      "OpenCode session stopped without findings submission; sending one retry prompt",
      {
        projectId: startedTask.projectId,
        workerId,
        taskId: startedTask.taskId,
        localRuntimeSessionId: startedTask.localRuntimeSessionId,
        status: stepStatus,
        agentSessionId,
        findingsFile: diagnostics.findingsFile,
        currentExecutionFile: diagnostics.currentExecutionFile,
        opencodeLogs: diagnostics.opencodeLogs,
      },
    );
    await deps.agentRunner.sendRetryPrompt({
      server: toOpencodeServerHandle(
        agent,
        startedTask.environment.workspaceFolder,
      ),
      sessionId: agentSessionId,
      promptText: FINDINGS_RETRY_PROMPT,
      agent: TASK_AGENT,
    });
    return "continue";
  }

  if (!state.hasWaitedForRetriedFindingsSubmission) {
    const diagnostics = await captureMissingFindingsDiagnostics({
      workspacePath: startedTask.environment.workspacePath,
      opencodeLogDirectory: agent.logDirectory,
      runtimeContainerId: startedTask.environment.runtimeContainerId,
    });
    state.hasWaitedForRetriedFindingsSubmission = true;
    logger.log(
      "worker",
      "OpenCode retry prompt was accepted but findings are still missing; waiting once more before failing",
      {
        projectId: startedTask.projectId,
        workerId,
        taskId: startedTask.taskId,
        localRuntimeSessionId: startedTask.localRuntimeSessionId,
        status: stepStatus,
        agentSessionId,
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

export async function captureOpencodeLogPreview(
  input: { logDirectory: string; containerId: string | null },
  runDockerExec: (
    args: string[],
  ) => Promise<{ stdout: string }> = defaultRunDockerExec,
): Promise<
  Array<{
    file: string;
    contentPreview: string;
  }>
> {
  if (input.containerId !== null) {
    return captureContainerOpencodeLogPreview(
      input.logDirectory,
      input.containerId,
      runDockerExec,
    );
  }

  try {
    const entries = await readdir(input.logDirectory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
      .slice(-4);

    return await Promise.all(
      files.map(async (file) => {
        const rawContent = await readFile(
          path.join(input.logDirectory, file),
          "utf8",
        ).catch(
          // eslint-disable-next-line local/no-unknown-parameter-type
          (error: unknown) => {
            return `Failed to read log: ${error instanceof Error ? error.message : String(error)}`;
          },
        );

        return {
          file,
          contentPreview: truncatePreview(rawContent),
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

/**
 * Read the last few OpenCode log files from inside a devcontainer via
 * `docker exec`. Container runs keep HOME on the container's native overlay
 * filesystem, so the log directory is no longer reachable from the host fs.
 */
async function captureContainerOpencodeLogPreview(
  logDirectory: string,
  containerId: string,
  runDockerExec: (args: string[]) => Promise<{ stdout: string }>,
): Promise<
  Array<{
    file: string;
    contentPreview: string;
  }>
> {
  try {
    const { stdout: listStdout } = await runDockerExec([
      "exec",
      containerId,
      "sh",
      "-lc",
      `ls -1 ${shQuote(logDirectory)} 2>/dev/null`,
    ]);
    const files = listStdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort()
      .slice(-4);

    return await Promise.all(
      files.map(async (file) => {
        const filePath = `${logDirectory}/${file}`;
        const { stdout } = await runDockerExec([
          "exec",
          containerId,
          "sh",
          "-lc",
          `if [ -f ${shQuote(filePath)} ]; then tail -c 2000 ${shQuote(filePath)}; fi`,
        ]);

        return {
          file,
          contentPreview: truncatePreview(stdout),
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
  runtimeContainerId: string | null;
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
    opencodeLogs: await captureOpencodeLogPreview({
      logDirectory: input.opencodeLogDirectory,
      containerId: input.runtimeContainerId,
    }),
  };
}

export async function collectStepArtifacts(
  deps: ProcessProjectWorkDeps,
  startedTask: Awaited<ReturnType<typeof startProcessClaimedTask>>,
  logger: ReturnType<typeof resolveProjectWorkLogger>,
): Promise<void> {
  const stepArtifactsDir = path.join(
    startedTask.environment.workspacePath,
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
      taskId: startedTask.taskId,
      relativeStorePath,
      sourcePath,
    });

    const kind = await detectArtifactKind(relativeStorePath, sourcePath);

    try {
      const result = await deps.artifactStore.saveArtifact({
        taskId: startedTask.taskId,
        claimToken: startedTask.claimToken,
        sourcePath,
        relativeStorePath,
        kind,
      });
      logger.log("worker", "Saved step artifact", {
        taskId: startedTask.taskId,
        relativeStorePath,
        storeRef: result.storeRef,
        sizeBytes: result.sizeBytes,
      });
    } catch (error) {
      logger.error("worker", "Failed to save step artifact", {
        taskId: startedTask.taskId,
        relativeStorePath,
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });

      try {
        const classified = classifyArtifactSaveError(error);
        await deps.workerClient.recordArtifactFailure({
          taskId: startedTask.taskId,
          claimToken: startedTask.claimToken,
          relativeStorePath,
          attemptedSizeBytes: fileStat.size,
          kind,
          errorCode: classified.errorCode,
          errorMessage: classified.errorMessage,
          ...(classified.httpStatus === null
            ? {}
            : { httpStatus: classified.httpStatus }),
        });
      } catch (reportingError) {
        logger.error("worker", "Failed to report step artifact save failure", {
          taskId: startedTask.taskId,
          relativeStorePath,
          error:
            reportingError instanceof Error
              ? reportingError.message
              : String(reportingError),
        });
      }
    }
  }

  try {
    await deps.artifactStore.prune?.();
  } catch (error) {
    logger.error("worker", "Failed to prune local artifacts", {
      taskId: startedTask.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
