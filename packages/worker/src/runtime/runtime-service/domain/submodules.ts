/**
 * Pure parsing for `git submodule status` output. No git execution lives here so
 * the edge-case logic stays trivially unit-testable.
 *
 * Each non-empty line has the shape:
 *
 *   <status-char><sha> <path> (<describe>)
 *
 * where the FIRST character is the status indicator:
 *  - `-`  submodule is not initialized       (`initialized: false`)
 *  - ` `  submodule is present and clean      (`initialized: true`)
 *  - `+`  present but checked-out SHA differs (`initialized: true`)
 *  - `U`  present with merge conflicts        (`initialized: true`)
 *
 * The trailing `(<describe>)` is optional and ignored.
 */

/** A single top-level submodule as reported by `git submodule status`. */
export type SubmoduleInfo = {
  /** Repo-relative path to the submodule working tree. */
  path: string;
  /** `false` only when git reports the `-` (uninitialized) status. */
  initialized: boolean;
};

/**
 * Parse the stdout of `git submodule status` into structured entries.
 *
 * Whitespace-only / empty input yields `[]`. The SHA length is not assumed
 * (git may abbreviate), so tokens are split rather than sliced by width.
 */
export function parseSubmoduleStatus(stdout: string): SubmoduleInfo[] {
  const results: SubmoduleInfo[] = [];

  for (const rawLine of stdout.split("\n")) {
    // Drop the trailing newline artifact; keep the line otherwise intact so the
    // leading status character (which may be a space) is preserved.
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0) {
      continue;
    }

    // The status indicator is always the first character.
    const statusChar = line[0];
    const initialized = statusChar !== "-";

    // Everything after the status char is `<sha> <path> (<describe>)`.
    const rest = line.slice(1).trim();
    const tokens = rest.split(/\s+/);
    // tokens[0] is the sha; tokens[1] is the path. Anything further is describe.
    const submodulePath = tokens[1];
    if (submodulePath === undefined || submodulePath.length === 0) {
      continue;
    }

    results.push({ path: submodulePath, initialized });
  }

  return results;
}
