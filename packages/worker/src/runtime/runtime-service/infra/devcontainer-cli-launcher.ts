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
  DevcontainerLaunchProgressLevel,
  DevcontainerLauncher,
  LaunchDevcontainerInput,
  LaunchDevcontainerResult,
  ResolveDevcontainerConfigInput,
} from "../application/devcontainer-launcher";

/**
 * The devcontainer CLI's numeric `LogLevel` values (from @devcontainers/cli
 * src/spec-utils/log.ts: Trace=1, Debug=2, Info=3, Warning=4, Error=5,
 * Critical=6). Emitted as the numeric `level` field on each `--log-format json`
 * event. Plain constants (not a TS enum) so comparisons against the raw numeric
 * field stay type-safe.
 */
const DEVCONTAINER_LOG_LEVEL_WARNING = 4;
const DEVCONTAINER_LOG_LEVEL_ERROR = 5;

/** Map the CLI's numeric LogLevel to our coarse progress severity. */
function mapDevcontainerLevel(
  level: number | undefined,
): DevcontainerLaunchProgressLevel {
  if (typeof level !== "number") {
    return "info";
  }
  if (level >= DEVCONTAINER_LOG_LEVEL_ERROR) {
    return "error";
  }
  if (level >= DEVCONTAINER_LOG_LEVEL_WARNING) {
    return "warn";
  }
  return "info";
}

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
 * Translate a single `--log-format json` line from the devcontainer CLI into
 * zero or more human-meaningful progress lines.
 *
 * The CLI emits newline-delimited JSON objects on **stderr**. The shapes we
 * handle (from @devcontainers/cli src/spec-utils/log.ts):
 *   - `{ "type": "start", "level", "text": "Running the postCreateCommand…" }`
 *     — a lifecycle phase begins. High-level phases in
 *     {@link MEANINGFUL_START_MARKERS} become `milestone`s; the `Run: …` starts
 *     become `detail` lines.
 *   - `{ "type": "stop", "level", "text", "startTimestamp" }` — a phase ends.
 *     Surfaced as a `detail` so the feed shows completion + timing.
 *   - `{ "type": "text" | "raw", "level", "text": "<subprocess output>" }` —
 *     captured stdout/stderr (npm/pip/bash `init.sh`). This is where real error
 *     detail lives, so we no longer drop it: each embedded line becomes its own
 *     `detail`, carrying the CLI's severity so errors ship even when info-level
 *     noise is filtered.
 *   - `{ "type": "progress", "name", "status": "running" }` — a named sub-task
 *     → `milestone`.
 *
 * Returns an array because `text`/`raw` events can carry multiple newline-
 * delimited lines. Non-JSON, empty, or unrecognized lines yield `[]`.
 */
export function parseDevcontainerProgress(
  line: string,
): DevcontainerLaunchProgress[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  const rawLevel = record["level"];
  const level = mapDevcontainerLevel(
    typeof rawLevel === "number" ? rawLevel : undefined,
  );

  if (record["type"] === "start" && typeof record["text"] === "string") {
    // Collapse to a single clean line — `start` texts are short, but guard
    // against stray newlines so a detail line can never break the log window.
    const text = toSingleLine(record["text"]);
    if (text.length === 0) {
      return [];
    }
    const isMilestone = MEANINGFUL_START_MARKERS.some((marker) =>
      text.includes(marker),
    );
    // High-level phase → primary status line; the `Run: <subcommand>` starts
    // are clean, informative one-liners → streamed detail lines beneath it.
    return [{ kind: isMilestone ? "milestone" : "detail", phase: text, level }];
  }

  if (record["type"] === "stop" && typeof record["text"] === "string") {
    const text = toSingleLine(record["text"]);
    return text.length > 0 ? [{ kind: "detail", phase: text, level }] : [];
  }

  // Named sub-tasks (e.g. "Installing Dotfiles") are milestones.
  if (
    record["type"] === "progress" &&
    record["status"] === "running" &&
    typeof record["name"] === "string"
  ) {
    const name = toSingleLine(record["name"]);
    return name.length > 0 ? [{ kind: "milestone", phase: name, level }] : [];
  }

  // `text` / `raw` are the raw subprocess byte streams (submodule clones,
  // npm/pip/bash output). One CLI event is one idea, so we ship the whole
  // payload as a single feed line (preserving its internal structure) rather
  // than exploding it into one line per embedded newline. The shipper strips
  // control chars and caps length, so an oversized payload is truncated rather
  // than dropped.
  if (
    (record["type"] === "text" || record["type"] === "raw") &&
    typeof record["text"] === "string"
  ) {
    const phase = cleanRawPayload(record["text"]);
    return phase.length > 0 ? [{ kind: "detail" as const, phase, level }] : [];
  }

  return [];
}

/** Collapse any whitespace runs (incl. newlines) into single spaces, trimmed. */
function toSingleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Clean a raw subprocess output blob for shipping as a single feed line:
 * strip ANSI escape sequences and trailing whitespace/newlines, while
 * preserving internal structure (embedded newlines/indentation) so a
 * multi-line payload — e.g. a pretty-printed JSON config dump — stays readable
 * as one log entry rather than being split across many.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /(?:\x9B|\x1B\[)[0-?]*[ -/]*[@-~]/gu;

function cleanRawPayload(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(/\s+$/u, "");
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
      for (const progress of parseDevcontainerProgress(line)) {
        // Best-effort: a throwing consumer must not break the launch.
        try {
          onProgress(progress);
        } catch {
          // Ignore consumer errors.
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
        const summary = extractDevcontainerErrorSummary(combined);
        // Attach the raw output as a non-enumerable property so the caller can
        // log it at debug level without it contaminating the human-readable
        // message that propagates to the reporter.
        const err = new Error(
          `devcontainer CLI exited with code ${String(code)}: ${summary}`,
        );
        (err as Error & { rawOutput: string }).rawOutput = combined;
        reject(err);
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

/**
 * Extract a short, human-readable failure summary from the raw combined
 * devcontainer CLI output. The CLI writes a terminal JSON object to stdout on
 * failure:
 *   {"outcome":"error","message":"Command failed: ...","description":"postCreateCommand failed.","containerId":"..."}
 * We prefer `description` (most concise) then `message`, then fall back to a
 * generic string so the caller never gets the full multi-KB dump.
 */
function extractDevcontainerErrorSummary(combined: string): string {
  // The outcome object is on stdout (first chunk of combined). Try every line.
  for (const line of combined.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj["outcome"] === "error") {
        const description =
          typeof obj["description"] === "string" ? obj["description"] : null;
        const message =
          typeof obj["message"] === "string" ? obj["message"] : null;
        return description ?? message ?? "devcontainer exited with an error";
      }
    } catch {
      // Not JSON — keep scanning.
    }
  }
  return "devcontainer CLI exited with a non-zero exit code";
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
      // The full CLI output already streamed to the durable feed line-by-line
      // via onProgress, so the failure log only needs the clean summary here —
      // no giant blob. The raw output remains on the error's `rawOutput` for
      // callers that want the tail (see extractDevcontainerErrorSummary).
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
