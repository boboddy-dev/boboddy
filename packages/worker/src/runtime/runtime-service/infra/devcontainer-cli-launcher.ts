import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ConfigurationError } from "../../../lib/errors";
import type {
  DevcontainerLauncher,
  LaunchDevcontainerInput,
  LaunchDevcontainerResult,
  ResolveDevcontainerConfigInput,
} from "../application/devcontainer-launcher";

const execFileAsync = promisify(execFile);
const DEVCONTAINER_CONFIG_CANDIDATES = [
  ".devcontainer/devcontainer.json",
  "devcontainer.json",
] as const;

/**
 * Returns the path to the devcontainer CLI bundle script set by the shim via
 * BOBODDY_DEVCONTAINER_SCRIPT. The shim always sets this to
 * dist/devcontainer/dist/spec-node/devcontainers-cli.js, which build.ts copies
 * from @devcontainers/cli for every build (local and CI alike), so it is always
 * present. The bundle is nested at that depth so that its __dirname-based
 * extensionPath computation (join(__dirname, "..", "..")) resolves to
 * dist/devcontainer/, where build.ts also places scripts/updateUID.Dockerfile
 * (used on Linux when remapping the container user's UID/GID).
 */
export function resolveDevcontainerCliScriptPath(): string {
  const scriptPath = process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
  if (scriptPath) {
    return scriptPath;
  }

  throw new ConfigurationError(
    "BOBODDY_DEVCONTAINER_SCRIPT is not set. This is normally injected by the " +
      "CLI shim (bin/boboddy). If running the worker directly, set this env var " +
      "to the path of dist/devcontainer/dist/spec-node/devcontainers-cli.js.",
    "DEVCONTAINER_CLI_NOT_FOUND",
  );
}

export function buildDevcontainerCliCommand(
  cliScriptPath: string,
  args: readonly string[],
): readonly [string, ...string[]] {
  // Use the current executable (the compiled Bun binary) as the JS runtime.
  // BUN_BE_BUN=1 (set in runDevcontainerCli) instructs the compiled binary to
  // act as the Bun CLI and execute the script rather than its own entrypoint.
  // This means users do not need a separate Node.js or Bun installation.
  return [process.execPath, cliScriptPath, ...args];
}

async function runDevcontainerCli(args: string[]): Promise<string> {
  const cliScriptPath = resolveDevcontainerCliScriptPath();
  const [command, ...commandArgs] = buildDevcontainerCliCommand(
    cliScriptPath,
    args,
  );
  // BUN_BE_BUN=1 instructs the compiled Bun binary to act as the Bun CLI and
  // execute the script passed as argv[1] rather than its own bundled entrypoint.
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    env: { ...process.env, BUN_BE_BUN: "1" },
  });

  return [stdout, stderr].filter(Boolean).join("\n");
}

function extractContainerId(output: string): string | null {
  const directMatch = output.match(/"containerId"\s*:\s*"([^"]+)"/u);
  if (directMatch?.[1]) {
    return directMatch[1];
  }

  return null;
}

export class DevcontainerCliLauncher implements DevcontainerLauncher {
  async resolveConfigPath(
    input: ResolveDevcontainerConfigInput,
  ): Promise<string> {
    for (const candidate of DEVCONTAINER_CONFIG_CANDIDATES) {
      try {
        await access(path.join(input.workspacePath, candidate));
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }

    throw new Error(
      `No devcontainer spec found in ${input.workspacePath}. Expected .devcontainer/devcontainer.json or devcontainer.json`,
    );
  }

  async launch(
    input: LaunchDevcontainerInput,
  ): Promise<LaunchDevcontainerResult> {
    try {
      const output = await runDevcontainerCli([
        "up",
        "--workspace-folder",
        input.workspacePath,
        "--config",
        path.join(input.workspacePath, input.devcontainerConfigPath),
        "--id-label",
        `boboddy.project-id=${input.projectId}`,
        "--id-label",
        `boboddy.project-runtime-session-id=${input.sessionId}`,
        "--id-label",
        `boboddy.requested-by-user-id=${input.requestedByUserId}`,
        "--log-format",
        "json",
      ]);
      const containerId = extractContainerId(output);

      if (!containerId) {
        throw new Error(
          `Devcontainer CLI did not return a containerId: ${output}`,
        );
      }

      return {
        containerId,
        metadata: {
          launchOutput: output.slice(-4_000),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to launch devcontainer: ${message}`, { cause: error });
    }
  }

  async stop(containerId: string): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "-f", containerId]);
    } catch {
      // Ignore missing or already-stopped containers.
    }
  }
}
