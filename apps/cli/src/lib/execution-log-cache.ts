import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FullLogSaver } from "@boboddy/platform-client";

/**
 * Where `execution view --log` saves a step's full, uncapped log. A sibling
 * of `LOG_DIR` (`logger.ts`) rather than nested inside it — that directory is
 * the CLI's own diagnostic pino output, a different concern.
 */
function resolveExecutionLogCacheDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".boboddy", "execution-logs");
}

export const EXECUTION_LOG_CACHE_DIR = resolveExecutionLogCacheDir();

export async function ensureExecutionLogCacheDir(
  dir: string = EXECUTION_LOG_CACHE_DIR,
): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Builds the disk-backed `saveFullLog` callback for `investigateExecution`
 * (`apps/cli/src/commands/execution.ts`). Every call overwrites any existing
 * file for the same `taskId`/stream. Failures propagate: `investigateExecution`
 * turns a rejection into `full log: not saved (<reason>)` on the header line.
 */
export function createFullLogSaver(
  cacheDir: string = EXECUTION_LOG_CACHE_DIR,
): FullLogSaver {
  return async ({ taskId, requestedStream, fullText }) => {
    await ensureExecutionLogCacheDir(cacheDir);
    const filePath = path.join(cacheDir, `${taskId}-${requestedStream}.log`);
    await writeFile(filePath, fullText, "utf8");
    return filePath;
  };
}
