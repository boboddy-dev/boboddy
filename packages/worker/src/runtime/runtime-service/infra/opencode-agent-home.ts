import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Shared preparation of a session-scoped OpenCode "agent HOME" on the host.
 *
 * Both runtime paths need an isolated per-session HOME that OpenCode reads its
 * global config (#2) and provider auth from:
 *
 *   - the `workspace` path bind-mounts it READ-WRITE into the devcontainer
 *     (see `devcontainer-opencode-bootstrap.ts`), and
 *   - the `no_workspace` path points the host OpenCode process's
 *     `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME` at it directly
 *     (see `host-opencode-bootstrap.ts`).
 *
 * Keeping this logic in one place avoids two copies of the config/auth copy +
 * resolution rules drifting apart.
 */

/**
 * Candidate filenames for the host global opencode config, in resolution order.
 * Mirrors the check in `opencode-credential-discovery.ts`.
 */
const HOST_GLOBAL_CONFIG_CANDIDATES = [
  "opencode.jsonc",
  "opencode.json",
  "config.json",
] as const;

/**
 * Relative path segments for the OpenCode auth store under the host home.
 * OpenCode reads provider credentials from `~/.local/share/opencode/auth.json`.
 * Mirrors `OPENCODE_AUTH_RELATIVE_PATH` in `opencode-credential-discovery.ts`.
 */
const HOST_AUTH_RELATIVE_PATH = [
  ".local",
  "share",
  "opencode",
  "auth.json",
] as const;

/**
 * Resolve the host home directory, honoring an explicit `HOME` override.
 * On macOS, `os.homedir()` reads the OS user database and ignores `process.env`,
 * so prefer the env var when set.
 */
export function resolveHostHome(): string {
  const explicit = process.env["HOME"]?.trim();
  return explicit && explicit.length > 0 ? explicit : os.homedir();
}

/**
 * Resolve a session-scoped agent HOME directory on the host. Lives under the
 * OS temp dir keyed by the runtime session id so it is isolated per session and
 * easy to GC; the orchestrator removes it on cleanup.
 */
export function resolveSessionAgentHomeDir(sessionId: string): string {
  return path.join(os.tmpdir(), "boboddy-agent-homes", sessionId);
}

/**
 * Sub-paths, relative to the session agent HOME, that the host OpenCode process
 * uses for its XDG dirs. Kept here so the host bootstrap and this module agree.
 */
export const AGENT_HOME_CONFIG_SUBDIR = path.join(".config");
export const AGENT_HOME_DATA_SUBDIR = path.join(".local", "share");

/**
 * Shared resolver for the host's global OpenCode config + provider auth.
 *
 * This reads (but does NOT write) the two host source files:
 *   - global config: first hit of `HOST_GLOBAL_CONFIG_CANDIDATES` under
 *     `<hostHome>/.config/opencode/`, and
 *   - provider auth:  `<hostHome>/.local/share/opencode/auth.json`.
 *
 * It is the single source of truth used by BOTH seeding strategies:
 *   - the host-write path (`prepareAgentHomeConfig`), which copies the resolved
 *     contents into a session-scoped host agent HOME, and
 *   - the container-tee path (`prepareAgentHome`), which pipes the resolved
 *     contents into a running container over stdin via `docker exec ... tee`.
 *
 * `hostConfigPath`/`hostConfigContent` are both `null` when no config candidate
 * exists. To preserve the historical external contract, `hostAuthPath` is the
 * actual path string only when the auth file was read; it is `null` when the
 * auth file is absent (in which case `hostAuthContent` is also `null`).
 */
export async function resolveHostAgentHomeSources(input: {
  /** Override host home dir (for tests). Defaults to resolved host home. */
  hostHomeDir?: string | undefined;
}): Promise<{
  hostConfigPath: string | null;
  hostConfigContent: string | null;
  hostAuthPath: string | null;
  hostAuthContent: string | null;
}> {
  const hostHome = input.hostHomeDir ?? resolveHostHome();

  // --- Config file ---
  const hostConfigDir = path.join(hostHome, ".config", "opencode");
  let hostConfigPath: string | null = null;
  let hostConfigContent: string | null = null;

  for (const candidate of HOST_GLOBAL_CONFIG_CANDIDATES) {
    const candidatePath = path.join(hostConfigDir, candidate);
    try {
      hostConfigContent = await readFile(candidatePath, "utf8");
      hostConfigPath = candidatePath;
      break;
    } catch {
      // Not found — try next candidate.
    }
  }

  // --- Auth file ---
  const resolvedAuthPath = path.join(hostHome, ...HOST_AUTH_RELATIVE_PATH);
  let hostAuthContent: string | null = null;
  try {
    hostAuthContent = await readFile(resolvedAuthPath, "utf8");
  } catch {
    // Not found — no auth file to copy.
  }

  return {
    hostConfigPath,
    hostConfigContent,
    // Preserve historical contract: only surface the path when content exists.
    hostAuthPath: hostAuthContent !== null ? resolvedAuthPath : null,
    hostAuthContent,
  };
}

/**
 * Copy the user's host global opencode config and auth credentials into the
 * session-scoped agent HOME so OpenCode picks them up without touching the
 * user's project repo.
 *
 * **Config** (`~/.config/opencode/opencode.json[c]`):
 *   Written to `<sessionAgentHomeDir>/.config/opencode/opencode.json` —
 *   OpenCode reads this at precedence level #2 (global config). Carries the
 *   user's `model`, provider options, plugins, etc.
 *
 * **Auth** (`~/.local/share/opencode/auth.json`):
 *   Written to `<sessionAgentHomeDir>/.local/share/opencode/auth.json` —
 *   OpenCode reads provider credentials from `$XDG_DATA_HOME/opencode/auth.json`.
 *
 * When neither file exists on the host, this is a no-op.
 */
export async function prepareAgentHomeConfig(input: {
  sessionAgentHomeDir: string;
  /** Override host home dir (for tests). Defaults to resolved host home. */
  hostHomeDir?: string | undefined;
}): Promise<{ hostConfigPath: string | null; hostAuthPath: string | null }> {
  const { hostConfigPath, hostConfigContent, hostAuthPath, hostAuthContent } =
    await resolveHostAgentHomeSources({ hostHomeDir: input.hostHomeDir });

  // Write config into the session agent HOME under .config/opencode/
  if (hostConfigContent !== null && hostConfigPath !== null) {
    const destConfigDir = path.join(
      input.sessionAgentHomeDir,
      ".config",
      "opencode",
    );
    await mkdir(destConfigDir, { recursive: true });
    const destConfigPath = path.join(destConfigDir, "opencode.json");
    await writeFile(destConfigPath, hostConfigContent, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  // Write auth into the session agent HOME under .local/share/opencode/
  if (hostAuthContent !== null) {
    const destAuthDir = path.join(
      input.sessionAgentHomeDir,
      ".local",
      "share",
      "opencode",
    );
    await mkdir(destAuthDir, { recursive: true });
    const destAuthPath = path.join(destAuthDir, "auth.json");
    await writeFile(destAuthPath, hostAuthContent, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  // `hostAuthPath` is already `null` when no auth content was resolved, so it
  // is returned directly here — preserving the original external contract.
  return { hostConfigPath, hostAuthPath };
}

/** Remove the session-scoped agent HOME from the host. */
export async function cleanupSessionHome(
  sessionAgentHomeDir: string,
): Promise<void> {
  await rm(sessionAgentHomeDir, { recursive: true, force: true });
}
