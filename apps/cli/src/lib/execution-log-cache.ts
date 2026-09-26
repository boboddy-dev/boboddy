import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StepExecutionLogStream } from "@boboddy/platform-client";

/**
 * Structurally mirrors `@boboddy/platform-client`'s `LogArtifactWriter`
 * (`packages/platform-client/src/lib/investigate-execution-client.ts`).
 * Defined locally rather than imported because the package only exposes a
 * single `"."` entry point (see its `package.json`), which does not
 * re-export that type; TypeScript's structural typing makes the two
 * interchangeable at the `investigateExecution({ writeLogArtifact })` call
 * site regardless.
 */
type LogArtifactWriter = (input: {
  stepExecutionId: string;
  requestedStream: StepExecutionLogStream | "all";
  fullText: string;
}) => Promise<string>;

/**
 * Where a step's full, untruncated log lands when `execution view --log`'s
 * rendered output would otherwise be truncated (decision 8 of
 * `docs/plans/execution-log-tail-truncation-and-file-cache.md`). A sibling
 * of `LOG_DIR` (`logger.ts:30`) rather than nested inside it — that
 * directory is the CLI's own diagnostic pino output, a different concern.
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
 * Builds the real, disk-backed `writeLogArtifact` callback for
 * `investigateExecution` (`apps/cli/src/commands/execution.ts`). Every write
 * overwrites any existing file for the same `stepExecutionId`/stream
 * (decision 8 — no cache-hit/skip-refetch logic). Failures are left to
 * propagate: the caller (`investigateExecution`'s `renderAndCapLogs`) already
 * catches and swallows a rejecting writer (decision 9), so this function does
 * not need its own try/catch.
 */
export function createExecutionLogArtifactWriter(
  cacheDir: string = EXECUTION_LOG_CACHE_DIR,
): LogArtifactWriter {
  return async ({ stepExecutionId, requestedStream, fullText }) => {
    await ensureExecutionLogCacheDir(cacheDir);
    const filePath = path.join(
      cacheDir,
      `${stepExecutionId}-${requestedStream}.log`,
    );
    await writeFile(filePath, fullText, "utf8");
    return filePath;
  };
}
