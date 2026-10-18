import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Shared preparation of a session-scoped OpenCode "agent HOME".
 *
 * Both runtime paths need an isolated per-session HOME that OpenCode reads the
 * user's global config (#2) from:
 *
 *   - the `workspace` path seeds it on the container's overlay filesystem
 *     (see `devcontainer-opencode-bootstrap.ts`), and
 *   - the `no_workspace` path points the host OpenCode process's `HOME`/`XDG_*`
 *     at it directly (see `host-opencode-bootstrap.ts`).
 *
 * Provider credentials are NOT copied into it: OpenCode 2.x keeps them in its
 * database, so they are injected into each session's server over its API
 * after boot (`opencode-credential-source.ts` / `opencode-credential-injection.ts`).
 */

/** Candidate filenames for the host global opencode config, in resolution order. */
const HOST_GLOBAL_CONFIG_CANDIDATES = [
  "opencode.jsonc",
  "opencode.json",
  "config.json",
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
 * Read (but do NOT write) the host's global OpenCode config: the first hit of
 * `HOST_GLOBAL_CONFIG_CANDIDATES` under `<hostHome>/.config/opencode/`. Both
 * `null` when no candidate exists.
 *
 * Shared by both seeding strategies: the host-write path
 * ({@link prepareAgentHomeConfig}) and the container-tee path
 * (`DevcontainerOpencodeBootstrap.prepareAgentHome`).
 */
export async function resolveHostAgentHomeSources(input: {
  /** Override host home dir (for tests). Defaults to resolved host home. */
  hostHomeDir?: string | undefined;
}): Promise<{
  hostConfigPath: string | null;
  hostConfigContent: string | null;
}> {
  const hostConfigDir = path.join(
    input.hostHomeDir ?? resolveHostHome(),
    ".config",
    "opencode",
  );
  for (const candidate of HOST_GLOBAL_CONFIG_CANDIDATES) {
    const candidatePath = path.join(hostConfigDir, candidate);
    try {
      const hostConfigContent = await readFile(candidatePath, "utf8");
      return { hostConfigPath: candidatePath, hostConfigContent };
    } catch {
      // Not found — try next candidate.
    }
  }
  return { hostConfigPath: null, hostConfigContent: null };
}

/**
 * Copy the user's host global opencode config into the session-scoped agent
 * HOME (`<sessionAgentHomeDir>/.config/opencode/opencode.json`, precedence #2)
 * without touching the user's project repo. A no-op when there is none.
 */
export async function prepareAgentHomeConfig(input: {
  sessionAgentHomeDir: string;
  /** Override host home dir (for tests). Defaults to resolved host home. */
  hostHomeDir?: string | undefined;
}): Promise<{ hostConfigPath: string | null }> {
  const { hostConfigPath, hostConfigContent } =
    await resolveHostAgentHomeSources({ hostHomeDir: input.hostHomeDir });

  if (hostConfigContent !== null) {
    const destConfigDir = path.join(
      input.sessionAgentHomeDir,
      ".config",
      "opencode",
    );
    await mkdir(destConfigDir, { recursive: true });
    await writeFile(
      path.join(destConfigDir, "opencode.json"),
      hostConfigContent,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }

  return { hostConfigPath };
}

/** Remove the session-scoped agent HOME from the host. */
export async function cleanupSessionHome(
  sessionAgentHomeDir: string,
): Promise<void> {
  await rm(sessionAgentHomeDir, { recursive: true, force: true });
}
