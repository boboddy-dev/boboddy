import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".boboddy/current-execution/execution.json";

export type CurrentExecutionInfo = {
  taskId: string;
  resultSchemaJson: Record<string, unknown> | null;
};

/** Reads `.boboddy/current-execution/execution.json` under the workspace. */
export async function loadCurrentExecutionInfo(
  worktree: string,
): Promise<CurrentExecutionInfo> {
  const currentExecutionInfoPath = path.join(
    worktree,
    CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  );

  try {
    await access(currentExecutionInfoPath);
  } catch {
    throw new Error(
      `Current execution metadata file not found at ${currentExecutionInfoPath}`,
    );
  }

  const rawPayload = await readFile(currentExecutionInfoPath, "utf8");
  const parsed: unknown = JSON.parse(rawPayload);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a JSON object`,
    );
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const taskId = parsedRecord["taskId"];
  const resultSchemaJson = parsedRecord["resultSchemaJson"];

  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error(
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a non-empty taskId`,
    );
  }

  if (
    resultSchemaJson !== null &&
    (typeof resultSchemaJson !== "object" || Array.isArray(resultSchemaJson))
  ) {
    throw new Error(
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a JSON object or null resultSchemaJson`,
    );
  }

  return {
    taskId,
    resultSchemaJson: resultSchemaJson as Record<string, unknown> | null,
  };
}

/** Like {@link loadCurrentExecutionInfo}, but `null` when it can't be read. */
export async function tryLoadCurrentExecutionInfo(
  worktree: string,
): Promise<CurrentExecutionInfo | null> {
  try {
    return await loadCurrentExecutionInfo(worktree);
  } catch {
    return null;
  }
}
