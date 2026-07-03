import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DevcontainerLauncher } from "../../../runtime/runtime-service/application/devcontainer-launcher";
import type { WorkspaceManager } from "../../../runtime/runtime-service/application/workspace-manager";
import { parseDevcontainerWorkspaceFolderFromContent } from "../../../runtime/runtime-service/infra/local-devcontainer-jsonc";
import { logWork } from "../application/work-logger";

export const execFileAsync = promisify(execFile);

/**
 * Resolve the devcontainer's own `workspaceFolder` from its (cloned) config, if
 * one is declared. Returns `null` when the config omits it (the CLI then mounts
 * at `/workspaces/<basename>`). With the single-container model, OpenCode runs
 * inside the devcontainer, so this is the agent-facing workspace folder.
 */
export async function resolveDevcontainerWorkspaceFolder(input: {
  workspacePath: string;
  devcontainerConfigPath: string;
}): Promise<string | null> {
  try {
    const configContent = await readFile(
      path.join(input.workspacePath, input.devcontainerConfigPath),
      "utf8",
    );
    return parseDevcontainerWorkspaceFolderFromContent(
      configContent,
      input.workspacePath,
    );
  } catch {
    return null;
  }
}

/**
 * Merges `envVars` into the `containerEnv` field of the cloned devcontainer.json.
 * `containerEnv` entries are passed as `-e KEY=VALUE` to `docker run` by the
 * devcontainers CLI, so they are baked into the container's persistent environment
 * and visible to all processes — including bare `docker exec env` calls.
 *
 * The devcontainer.json in the cloned workspace is ephemeral, so mutating it
 * here is safe and does not affect the user's source repo.
 *
 * devcontainer.json may contain JS-style `// comments`, which JSON.parse
 * cannot handle. We do a targeted string patch rather than a full parse/rewrite
 * to avoid corrupting the file.
 */
export async function patchDevcontainerEnv(
  workspacePath: string,
  devcontainerConfigPath: string,
  envVars: Record<string, string>,
): Promise<void> {
  const configAbsPath = path.join(workspacePath, devcontainerConfigPath);
  const raw = await readFile(configAbsPath, "utf8");

  // Strip JS-style line comments so we can parse the JSON.
  const stripped = raw.replace(/\/\/[^\n]*/g, "");
  const parsed = JSON.parse(stripped) as Record<string, unknown>;

  // Merge: our vars extend existing containerEnv without overwriting user-defined ones.
  const existing =
    parsed["containerEnv"] && typeof parsed["containerEnv"] === "object"
      ? (parsed["containerEnv"] as Record<string, string>)
      : {};
  parsed["containerEnv"] = { ...envVars, ...existing };

  await writeFile(configAbsPath, JSON.stringify(parsed, null, 2), "utf8");
}

export async function inspectContainerHealthStatus(
  containerId: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      containerId,
    ]);
    return stdout.trim() || "unknown";
  } catch (error) {
    return `unreachable:${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Tear down the single runtime: the devcontainer (which also hosts OpenCode) and
 * the cloned workspace. There is no AI container or session network to remove.
 */
export async function cleanupEnvironment(input: {
  workspacePath: string | null;
  devcontainerId: string | null;
  deps: {
    workspaceManager: WorkspaceManager;
    devcontainerLauncher: DevcontainerLauncher;
  };
}) {
  logWork("runtime", "Cleaning up local runtime environment", {
    workspacePath: input.workspacePath,
    devcontainerId: input.devcontainerId,
  });

  await Promise.allSettled([
    input.devcontainerId
      ? input.deps.devcontainerLauncher.stop(input.devcontainerId)
      : Promise.resolve(),
    input.workspacePath
      ? input.deps.workspaceManager.removeWorkspace(input.workspacePath)
      : Promise.resolve(),
  ]);

  logWork("runtime", "Local runtime environment cleanup complete", {
    workspacePath: input.workspacePath,
    devcontainerId: input.devcontainerId,
  });
}
