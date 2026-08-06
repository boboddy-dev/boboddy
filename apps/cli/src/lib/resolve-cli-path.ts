import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolve an absolute, directly-executable path to the CLI the user is
 * currently running, for handing to a child process as `$BOBODDY_CLI`.
 *
 * The subtlety is that "the CLI" is not one thing:
 *
 *   - **Shipped (`bun build --compile`)** — `process.execPath` IS the CLI. The
 *     standalone binary re-execs itself as its own runtime, so `argv[1]` points
 *     at bun's embedded virtual filesystem (`/$bunfs/root/<name>`) rather than
 *     any real path. That embedded prefix is the reliable discriminator.
 *   - **Dev (`bun run src/index.ts`)** — `process.execPath` is the *bun* binary
 *     and `argv[1]` is the entry script, so neither is executable on its own
 *     ("bun run <script>" is two argv entries, and `$BOBODDY_CLI` has to be
 *     quotable as one). We fall back to the repo's `bin/boboddy` wrapper, which
 *     is a real executable with a shebang, and finally to the bare command name
 *     for a globally-linked install.
 *
 * Verified empirically against bun 1.3.x on darwin-arm64:
 *   compiled → execPath=<binary>, argv[1]="/$bunfs/root/<name>"
 *   dev      → execPath=<…>/bin/bun, argv[1]="<repo>/apps/cli/src/index.ts"
 */

/**
 * Prefixes bun uses for the virtual filesystem inside a `--compile` standalone
 * binary. Posix uses `/$bunfs/`; Windows uses a `B:\~BUN\` drive alias.
 */
const EMBEDDED_ENTRY_PREFIXES: readonly string[] = [
  "/$bunfs/",
  "B:\\~BUN\\",
  "b:\\~bun\\",
  "/~BUN/",
];

/** Last-resort value: rely on `boboddy` being on the child's PATH. */
export const BOBODDY_CLI_FALLBACK_COMMAND = "boboddy";

/**
 * True when `entryPath` (i.e. `process.argv[1]`) lives in bun's embedded
 * virtual filesystem, which only happens inside a compiled standalone binary.
 */
export function isCompiledStandaloneEntry(
  entryPath: string | undefined,
): boolean {
  if (entryPath === undefined || entryPath.length === 0) {
    return false;
  }
  return EMBEDDED_ENTRY_PREFIXES.some((prefix) => entryPath.startsWith(prefix));
}

export type ResolveBoboddyCliPathInput = {
  /** `process.execPath`. */
  execPath: string;
  /** `process.argv[1]`. */
  entryPath: string | undefined;
  /**
   * An explicit `BOBODDY_CLI` already in the environment. Honoured verbatim so
   * an outer harness (or a nested design session) can pin the binary.
   */
  envOverride?: string | undefined;
  /** Filesystem probe seam (tests). */
  fileExists?: ((path: string) => boolean) | undefined;
};

/** Resolve the value to expose to child processes as `BOBODDY_CLI`. */
export function resolveBoboddyCliPath(
  input: ResolveBoboddyCliPathInput,
): string {
  const override = input.envOverride?.trim() ?? "";
  if (override.length > 0) {
    return override;
  }

  if (isCompiledStandaloneEntry(input.entryPath)) {
    return input.execPath;
  }

  const fileExists = input.fileExists ?? existsSync;
  const entryPath = input.entryPath;
  if (entryPath !== undefined && entryPath.length > 0) {
    // <repo>/apps/cli/src/index.ts → <repo>/apps/cli/bin/boboddy
    const wrapper = resolve(dirname(entryPath), "..", "bin", "boboddy");
    if (fileExists(wrapper)) {
      return wrapper;
    }
  }

  return BOBODDY_CLI_FALLBACK_COMMAND;
}

/** Convenience wrapper around {@link resolveBoboddyCliPath} for the live process. */
export function resolveCurrentBoboddyCliPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveBoboddyCliPath({
    execPath: process.execPath,
    entryPath: process.argv[1],
    envOverride: env["BOBODDY_CLI"],
  });
}
