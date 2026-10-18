import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Whether the process recorded in `pidPath` inside `containerId` is still
 * running. `null` when that cannot be determined (no pid file yet, docker
 * failure), which callers treat as "keep waiting".
 *
 * Reads the process state from /proc rather than `kill -0`: without an init
 * process in the container an exited process lingers as a zombie, which
 * `kill -0` still reports as present.
 */
export async function isContainerProcessAlive(
  containerId: string,
  pidPath: string,
): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      containerId,
      "sh",
      "-lc",
      `if [ ! -f ${shQuote(pidPath)} ]; then echo unknown; exit 0; fi; ` +
        `state=$(sed 's/.*) //' "/proc/$(cat ${shQuote(pidPath)})/stat" 2>/dev/null | cut -d' ' -f1); ` +
        `if [ -z "$state" ] || [ "$state" = Z ]; then echo dead; else echo alive; fi`,
    ]);
    const state = stdout.trim();
    if (state === "alive") {
      return true;
    }
    if (state === "dead") {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}
