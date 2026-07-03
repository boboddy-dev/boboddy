import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ConfigurationError } from "../../../lib/errors";
import {
  logWork,
  logWorkDebug,
  logWorkError,
} from "../../../work/step-execution/application/work-logger";
import type {
  DevcontainerLaunchProgress,
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

/**
 * Substrings that mark a `start` log line as a *meaningful lifecycle
 * milestone* worth showing the user. The devcontainer CLI emits a `start`
 * event for every internal subprocess (`Run: git …`, `Run: docker …`), which
 * is far too chatty for a spinner; we surface only the high-level phases.
 */
const MEANINGFUL_START_MARKERS = [
  "Resolving Remote",
  "Building image",
  "Creating container",
  "Starting container",
  "Running the onCreateCommand",
  "Running the updateContentCommand",
  "Running the postCreateCommand",
  "Running the postStartCommand",
  "Running the postAttachCommand",
  "Running the initializeCommand",
] as const;

/**
 * Translate a single `--log-format json` line from the devcontainer CLI into a
 * human-meaningful progress phase, or `null` if the line carries no
 * user-relevant milestone.
 *
 * The CLI emits newline-delimited JSON objects on **stderr**. The shapes we
 * care about (observed from the bundled @devcontainers/cli):
 *   - `{ "type": "start", "text": "Running the postCreateCommand…" }` — a
 *     lifecycle phase begins. Only the high-level phases in
 *     {@link MEANINGFUL_START_MARKERS} are surfaced; the high-volume
 *     `Run: <subcommand>` starts are dropped.
 *   - `{ "type": "progress", "name": "Installing Dotfiles", "status": "running" }`
 *     — a named sub-task.
 *
 * `text` / `raw` log lines are intentionally ignored here: they are high-volume
 * command output (npm/pip/playwright noise) better left to the pino debug log.
 */
export function parseDevcontainerProgress(
  line: string,
): DevcontainerLaunchProgress | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;

  if (record["type"] === "start" && typeof record["text"] === "string") {
    // Collapse to a single clean line — `start` texts are short, but guard
    // against stray newlines so a detail line can never break the log window.
    const text = toSingleLine(record["text"]);
    if (text.length === 0) {
      return null;
    }
    const isMilestone = MEANINGFUL_START_MARKERS.some((marker) =>
      text.includes(marker),
    );
    // High-level phase → primary status line; the `Run: <subcommand>` starts
    // are clean, informative one-liners → streamed detail lines beneath it.
    return { kind: isMilestone ? "milestone" : "detail", phase: text };
  }

  // Named sub-tasks (e.g. "Installing Dotfiles") are milestones.
  if (
    record["type"] === "progress" &&
    record["status"] === "running" &&
    typeof record["name"] === "string"
  ) {
    const name = toSingleLine(record["name"]);
    return name.length > 0 ? { kind: "milestone", phase: name } : null;
  }

  // `text` / `raw` are the raw, often multi-line byte streams of subprocess
  // output (submodule clones, npm/pip noise). Far too noisy for the live
  // window and they carry embedded newlines — drop them; the full output is
  // still captured in the combined result and pino logs.
  return null;
}

/** Collapse any whitespace runs (incl. newlines) into single spaces, trimmed. */
function toSingleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Run the devcontainer CLI, streaming its output line-by-line so lifecycle
 * progress (e.g. "Running the postCreateCommand…") can be surfaced to the user
 * in real time via `onProgress`. Resolves with the combined stdout+stderr once
 * the process exits 0; rejects with a descriptive error (including captured
 * output) on any non-zero exit or spawn failure.
 *
 * Note: with `--log-format json` the CLI writes its progress log lines
 * (`type: "start" | "progress" | …`) to **stderr** — stdout carries only the
 * final result object (the `containerId`). So progress parsing reads stderr;
 * stdout is captured purely to extract the container id afterwards.
 */
async function runDevcontainerCli(
  args: string[],
  onProgress?: (progress: DevcontainerLaunchProgress) => void,
): Promise<string> {
  const cliScriptPath = resolveDevcontainerCliScriptPath();
  const [command, ...commandArgs] = buildDevcontainerCliCommand(
    cliScriptPath,
    args,
  );

  return await new Promise<string>((resolve, reject) => {
    // BUN_BE_BUN=1 instructs the compiled Bun binary to act as the Bun CLI and
    // execute the script passed as argv[1] rather than its own bundled
    // entrypoint.
    const child = spawn(command, commandArgs, {
      env: { ...process.env, BUN_BE_BUN: "1" },
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stderrBuffer = "";

    const handleProgressLine = (line: string): void => {
      if (!onProgress) {
        return;
      }
      const progress = parseDevcontainerProgress(line);
      if (progress) {
        // Best-effort: a throwing reporter must not break the launch.
        try {
          onProgress(progress);
        } catch {
          // Ignore reporter errors.
        }
      }
    };

    // stdout: result JSON only (containerId). Just buffer it.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutChunks.push(chunk);
    });

    // stderr: newline-delimited JSON progress log. Parse line-by-line.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk;
      let newlineIndex = stderrBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        handleProgressLine(line);
        newlineIndex = stderrBuffer.indexOf("\n");
      }
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      // Flush any trailing partial line.
      if (stderrBuffer.length > 0) {
        handleProgressLine(stderrBuffer);
      }
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      if (code === 0) {
        resolve(combined);
      } else {
        reject(
          new Error(
            `devcontainer CLI exited with code ${String(code)}: ${combined}`,
          ),
        );
      }
    });
  });
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
    logWork("runtime", "Launching devcontainer", {
      sessionId: input.sessionId,
      projectId: input.projectId,
      workspacePath: input.workspacePath,
      devcontainerConfigPath: input.devcontainerConfigPath,
    });

    try {
      const output = await runDevcontainerCli(
        [
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
        ],
        input.onProgress,
      );

      logWorkDebug("runtime", "Devcontainer CLI output", {
        sessionId: input.sessionId,
        output: output.slice(-4_000),
      });

      const containerId = extractContainerId(output);

      if (!containerId) {
        throw new Error(
          `Devcontainer CLI did not return a containerId: ${output}`,
        );
      }

      logWork("runtime", "Devcontainer launched", {
        sessionId: input.sessionId,
        containerId,
      });

      return {
        containerId,
        metadata: {
          launchOutput: output.slice(-4_000),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWorkError("runtime", "Devcontainer launch failed", {
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        devcontainerConfigPath: input.devcontainerConfigPath,
        error: message,
      });
      throw new Error(`Failed to launch devcontainer: ${message}`, { cause: error });
    }
  }

  async stop(containerId: string): Promise<void> {
    logWork("runtime", "Stopping devcontainer", { containerId });
    try {
      await execFileAsync("docker", ["rm", "-f", containerId]);
      logWork("runtime", "Devcontainer stopped", { containerId });
    } catch (error) {
      // Ignore missing or already-stopped containers.
      logWorkDebug("runtime", "Devcontainer stop had no effect (already removed or missing)", {
        containerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
