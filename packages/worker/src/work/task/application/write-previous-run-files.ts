import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  renderConversationTranscript,
  type TaskLogLinesResult,
} from "@boboddy/platform-client";
import type { ProjectWorkLogger } from "../contracts/process-project-work-types";
import type { PreviousRunContract } from "../contracts/task-contracts";
import { logWork, logWorkWarn } from "./work-logger";

export type PreviousRunFilesInput = {
  run: PreviousRunContract;
  stepKey: string;
  loadLogLines(): Promise<TaskLogLinesResult>;
};

export type PreviousRunFilesResult = {
  findingsPath: string;
  transcriptPath: string | null;
};

/**
 * Writes a steered rerun's view of its previous run into the workspace: the
 * findings it submitted (`null` when it submitted none) and its rendered
 * conversation transcript. The transcript is best-effort: when the logs cannot
 * be read (read quota, no archive, a failed download) it is skipped and the
 * reason logged, since the prompt already tells the agent it may be missing.
 */
export async function writePreviousRunFiles(
  workspacePath: string,
  input: PreviousRunFilesInput,
  logger?: ProjectWorkLogger,
): Promise<PreviousRunFilesResult> {
  const findingsPath = path.join(workspacePath, input.run.findingsRelativePath);
  const transcriptPath = path.join(
    workspacePath,
    input.run.transcriptRelativePath,
  );

  await mkdir(path.dirname(findingsPath), { recursive: true });
  await writeFile(
    findingsPath,
    `${JSON.stringify(input.run.findingsJson ?? null, null, 2)}\n`,
    "utf8",
  );

  const transcript = await renderPreviousRunTranscript(input);
  if ("skipped" in transcript) {
    const message = `previous run transcript skipped for task ${input.run.taskId}: ${transcript.skipped}`;
    logWorkWarn("runtime", message, { previousTaskId: input.run.taskId });
    logger?.log("runtime", message);
    return { findingsPath, transcriptPath: null };
  }

  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, `${transcript.text}\n`, "utf8");
  logWork("runtime", "Previous run files written", {
    previousTaskId: input.run.taskId,
    findingsPath,
    transcriptPath,
  });
  return { findingsPath, transcriptPath };
}

async function renderPreviousRunTranscript(
  input: PreviousRunFilesInput,
): Promise<{ text: string } | { skipped: string }> {
  try {
    const loaded = await input.loadLogLines();
    if ("unavailable" in loaded) return { skipped: loaded.unavailable };
    return {
      text: renderConversationTranscript({
        stepKey: input.stepKey,
        lines: loaded.lines,
        source: loaded.source,
      }),
    };
  } catch (error) {
    return {
      skipped: error instanceof Error ? error.message : String(error),
    };
  }
}
