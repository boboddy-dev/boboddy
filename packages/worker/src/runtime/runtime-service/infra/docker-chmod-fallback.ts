import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CHMOD_FALLBACK_IMAGE = "alpine:3.20";

/**
 * True when `error` is a filesystem/exec permission error (EACCES/EPERM). Some
 * repo files are written by the root-run devcontainer and end up owned by root
 * on the host, so host-side git/fs operations against them fail with these codes.
 */
export function isPermissionError(
  error: Error | NodeJS.ErrnoException | null | undefined,
): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  if (code === "EACCES" || code === "EPERM") return true;
  // execFile surfaces some permission failures only in the message.
  return /permission denied|EACCES|EPERM/i.test(error.message);
}

/**
 * Make every file under `targetPath` world-writable via a throwaway Alpine
 * container. Used to recover from root-owned files created by the (root-run)
 * devcontainer so subsequent host-side git operations succeed. Best-effort:
 * mirrors the workspace-cleanup fallback in local-workspace-manager.ts.
 */
export async function chmodRecursiveWithDocker(
  targetPath: string,
): Promise<void> {
  await execFileAsync("docker", [
    "run",
    "--rm",
    "-v",
    `${targetPath}:/workspace`,
    "--entrypoint",
    "sh",
    CHMOD_FALLBACK_IMAGE,
    "-lc",
    "chmod -R 0777 /workspace 2>/dev/null || true",
  ]);
}
