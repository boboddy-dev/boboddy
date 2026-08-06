import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Installing dependencies into `.boboddy/pipeline-builder`.
 *
 * `detect-pipeline-runtime.ts` answers "how do I *run* a script here?" from the
 * lockfile, which only works once dependencies exist. This module answers the
 * prior question — "how do I create that lockfile?" — for a directory that was
 * just scaffolded and has nothing in it but a `package.json`.
 */

/**
 * The marker `boboddy pipelines push` checks for. Using the same probe here
 * means a successful preflight guarantees a later push won't bail on it.
 */
export function builderDependenciesInstalled(builderDir: string): boolean {
  return existsSync(join(builderDir, "node_modules", "@boboddy", "sdk"));
}

export type BuilderInstaller = {
  /** Executable to spawn. */
  command: string;
  /** Arguments. */
  args: readonly string[];
  /** Human-readable command, for status lines and error messages. */
  label: string;
};

/**
 * Lockfile → installer. Checked before PATH so an existing project keeps using
 * the package manager it was set up with.
 */
const LOCKFILE_INSTALLERS: ReadonlyArray<readonly [string, BuilderInstaller]> = [
  ["bun.lock", { command: "bun", args: ["install"], label: "bun install" }],
  ["bun.lockb", { command: "bun", args: ["install"], label: "bun install" }],
  [
    "pnpm-lock.yaml",
    { command: "pnpm", args: ["install"], label: "pnpm install" },
  ],
  ["yarn.lock", { command: "yarn", args: ["install"], label: "yarn install" }],
  [
    "package-lock.json",
    { command: "npm", args: ["install"], label: "npm install" },
  ],
  ["deno.lock", { command: "deno", args: ["install"], label: "deno install" }],
  ["deno.json", { command: "deno", args: ["install"], label: "deno install" }],
];

/**
 * Fresh-directory fallback order. `bun` first because the CLI itself ships as a
 * bun binary, so a bun-shaped project is the least surprising default; `npm` is
 * the universal backstop.
 */
const FALLBACK_INSTALLERS: readonly BuilderInstaller[] = [
  { command: "bun", args: ["install"], label: "bun install" },
  { command: "npm", args: ["install"], label: "npm install" },
];

export type ResolveBuilderInstallerOptions = {
  /** Filesystem probe seam (tests). */
  fileExists?: ((path: string) => boolean) | undefined;
  /** PATH probe seam (tests). */
  hasCommand?: ((command: string) => boolean) | undefined;
};

/**
 * Pick the install command for `builderDir`, or `null` when no supported
 * package manager is available.
 */
export function resolveBuilderInstaller(
  builderDir: string,
  options: ResolveBuilderInstallerOptions = {},
): BuilderInstaller | null {
  const fileExists = options.fileExists ?? existsSync;
  const hasCommand = options.hasCommand ?? isCommandOnPath;

  for (const [lockfile, installer] of LOCKFILE_INSTALLERS) {
    if (fileExists(join(builderDir, lockfile))) {
      return installer;
    }
  }

  for (const installer of FALLBACK_INSTALLERS) {
    if (hasCommand(installer.command)) {
      return installer;
    }
  }

  return null;
}

/** The message shown when {@link resolveBuilderInstaller} finds nothing. */
export const NO_PACKAGE_MANAGER_MESSAGE =
  "No package manager was found on your PATH. Install bun (https://bun.sh) " +
  "or Node.js with npm, then re-run this command.";

export type RunBuilderInstallInput = {
  builderDir: string;
  installer: BuilderInstaller;
  /** Injected spawn (tests). */
  spawnFn?: typeof spawn | undefined;
};

/**
 * Run the install, streaming its output straight to the user's terminal so a
 * slow or failing install is never a silent spinner.
 */
export async function runBuilderInstall(
  input: RunBuilderInstallInput,
): Promise<void> {
  const spawnFn = input.spawnFn ?? spawn;
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawnFn(
      input.installer.command,
      [...input.installer.args],
      { cwd: input.builderDir, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      resolvePromise(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(
      `\`${input.installer.label}\` failed (exit ${String(exitCode)}) in ` +
        `${input.builderDir}. Fix the install and re-run this command.`,
    );
  }
}

/** `command -v`-style PATH probe that never throws. */
function isCommandOnPath(command: string): boolean {
  try {
    return Bun.which(command) !== null;
  } catch {
    return false;
  }
}
