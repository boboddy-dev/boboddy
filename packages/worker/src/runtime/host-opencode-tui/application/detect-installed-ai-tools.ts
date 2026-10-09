import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Detect which third-party AI coding tools the user already has installed, so
 * the provider-connect step can point them at the matching OpenCode option.
 *
 * PRIVACY: detection reads tool NAMES only. It checks whether a binary exists
 * on `PATH` and whether a config directory exists under the home directory —
 * existence only. It never lists or reads anything inside those directories,
 * never opens a credential file, and never touches the Keychain. Subscription
 * OAuth tokens belonging to other tools are not ours to read or move.
 */

export type InstalledAiTool = "claude" | "codex" | "copilot";

export type DetectInstalledAiToolsInput = {
  /** Host home dir override (tests). Defaults to `HOME`/`os.homedir()`. */
  homeDir?: string | undefined;
  /** Env source override (tests). Defaults to `process.env`. */
  env?: ((name: string) => string | undefined) | undefined;
  /** Platform override (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Existence probe override (tests). Defaults to `fs.existsSync`. */
  exists?: ((absolutePath: string) => boolean) | undefined;
};

type ToolHeuristic = {
  tool: InstalledAiTool;
  binary: string;
  configDirs: ReadonlyArray<readonly string[]>;
};

const TOOL_HEURISTICS: readonly ToolHeuristic[] = [
  { tool: "claude", binary: "claude", configDirs: [[".claude"]] },
  { tool: "codex", binary: "codex", configDirs: [[".codex"]] },
  {
    tool: "copilot",
    binary: "copilot",
    configDirs: [
      [".config", "github-copilot"],
      [".local", "share", "gh", "extensions", "gh-copilot"],
    ],
  },
];

const WINDOWS_EXECUTABLE_SUFFIXES = ["", ".exe", ".cmd"] as const;

/**
 * Return the sorted, de-duplicated set of AI tools that appear to be installed,
 * judged by a binary on `PATH` or a config directory under the home directory.
 */
export function detectInstalledAiTools(
  input: DetectInstalledAiToolsInput,
): Promise<InstalledAiTool[]> {
  const env = input.env ?? ((name: string) => process.env[name]);
  const platform = input.platform ?? process.platform;
  const exists = input.exists ?? existsSync;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const homeDir = input.homeDir ?? resolveHostHome(env);
  const binarySuffixes =
    platform === "win32" ? WINDOWS_EXECUTABLE_SUFFIXES : [""];
  const pathDirs = (env("PATH") ?? "")
    .split(pathApi.delimiter)
    .filter((dir) => dir.length > 0);

  const isOnPath = (binary: string): boolean =>
    pathDirs.some((dir) =>
      binarySuffixes.some((suffix) =>
        exists(pathApi.join(dir, `${binary}${suffix}`)),
      ),
    );

  const hasConfigDir = (segments: readonly string[]): boolean =>
    exists(pathApi.join(homeDir, ...segments));

  const detected = new Set<InstalledAiTool>();
  for (const heuristic of TOOL_HEURISTICS) {
    if (isOnPath(heuristic.binary) || heuristic.configDirs.some(hasConfigDir)) {
      detected.add(heuristic.tool);
    }
  }

  return Promise.resolve(
    [...detected].sort((left, right) => left.localeCompare(right)),
  );
}

/**
 * Resolve the host home directory, honoring an explicit `HOME` override. Mirrors
 * `resolveHostHome` in `opencode-credential-discovery.ts`.
 */
function resolveHostHome(env: (name: string) => string | undefined): string {
  const explicit = env("HOME")?.trim();
  return explicit && explicit.length > 0 ? explicit : os.homedir();
}
