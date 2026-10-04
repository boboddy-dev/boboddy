/**
 * Executes a `kind: "code"` step definition's entrypoint — a plain function
 * living in the target repo's own checkout — instead of prompting an AI
 * agent.
 *
 * Mechanism (bind-mount trick, avoids streaming code over `docker exec`
 * stdin): a small runner script + the step's input JSON are written directly
 * to the HOST workspace path (`environment.workspacePath`) with plain
 * `fs.writeFile` — no docker needed for the write itself, since the workspace
 * is bind-mounted into the devcontainer and the same files are instantly
 * visible inside the container at the equivalent path under
 * `environment.workspaceFolder`. The runner is then executed either via
 * `docker exec <runtimeContainerId> sh -lc "..."` (workspace mode) or
 * directly via a host shell (`no_workspace` mode, where `workspaceFolder`
 * equals `workspacePath` and there is no container).
 *
 * The runner lives beside the step's module (`.code-step-runner-<uuid>.mjs`
 * in `dirname(sourceFile)`) so its bare `@boboddy/sdk/code-step-lookup` import
 * resolves the way the module's own imports do; the input JSON stays in
 * `.boboddy/tmp/`. The runner is removed afterwards, and stale ones left by a
 * crash are swept before each write, so a later commit cannot pick one up.
 *
 * The runner script dynamically `import()`s the entrypoint module, finds the
 * code step by key (see `code-step-runner-script.ts`), calls it with the
 * parsed input JSON, and writes the result to
 * `.boboddy/step-findings-submission.json` in the exact shape the OpenCode
 * plugin's `boboddy-submit-step-findings` tool already writes (see
 * `buildFindingsSubmissionPath` / `process-project-work-findings.ts`, reused
 * here verbatim) — the downstream `tryPersistAgentFindings` path needs zero
 * changes, since it is already agnostic to how `resultJson` was produced.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createUuidV7 } from "../../../common/contracts/uuid-v7";
import { buildDockerEnvFlags } from "../../../runtime/runtime-service/infra/docker-env-flags";
import { CODE_STEP_RUNNER_SCRIPT_SOURCE } from "./code-step-runner-script";
import { buildFindingsSubmissionPath } from "./process-project-work-findings";
import { shQuote } from "./process-project-work-monitor-helpers";

const execFileAsync = promisify(execFile);

/** Relative (POSIX) location under the workspace root for the step's input file. */
const CODE_STEP_TMP_RELATIVE_DIR = ".boboddy/tmp";

const CODE_STEP_RUNNER_PREFIX = ".code-step-runner-";
const CODE_STEP_RUNNER_SUFFIX = ".mjs";

export type CodeStepRuntime = "bun" | "node";

export type CodeStepEntrypoint = {
  sourceFile: string;
};

export type ExecuteCodeStepInput = {
  environment: {
    /** Host filesystem path to the cloned workspace (bind-mount source). */
    workspacePath: string;
    /**
     * The workspace root as seen by whatever process runs the code — the
     * in-container path for `workspace` mode, or the same value as
     * `workspacePath` for `no_workspace` mode (see module doc comment).
     */
    workspaceFolder: string;
    /** `null` for `no_workspace` runs (no container; run directly on host). */
    runtimeContainerId: string | null;
  };
  entrypointJson: CodeStepEntrypoint;
  /** The step definition's key, which the runner looks up in the module. */
  stepKey: string;
  inputJson: unknown;
  /**
   * The runtime a managed step's image provides, invoked directly. Omitted for
   * a step in the project's own devcontainer, where bun, then node, is
   * whichever the container has on `PATH`.
   */
  runtime?: CodeStepRuntime | undefined;
  /**
   * The step's resolved environment variables (`resolveStepEnv`), visible to
   * the entrypoint through `process.env`. May carry secrets: they travel as
   * `docker exec -e` argv / the `execFile` env option and never enter
   * `shellCommand`.
   */
  stepEnv?: Readonly<Record<string, string>> | undefined;
};

export type RunCodeStepCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Injectable command-runner seam, mirroring `process-project-work-monitor-
 * helpers.ts`'s `runDockerExec` param: unit tests inject a fake here so they
 * can assert on the constructed command without ever shelling out to a real
 * `docker`/`sh` binary.
 */
export type RunCodeStepCommand = (input: {
  runtimeContainerId: string | null;
  shellCommand: string;
  /** Extra environment for the runner process; see {@link ExecuteCodeStepInput.stepEnv}. */
  env?: Readonly<Record<string, string>> | undefined;
}) => Promise<RunCodeStepCommandResult>;

function redactEnvValues(
  text: string,
  env: Readonly<Record<string, string>> | undefined,
): string {
  return Object.values(env ?? {}).reduce(
    (redacted, value) =>
      value.length > 0 ? redacted.replaceAll(value, "***") : redacted,
    text,
  );
}

/**
 * Default command runner: `docker exec [-e K=V ...] <containerId> sh -lc
 * "<cmd>"` for workspace mode, a plain `sh -lc "<cmd>"` on the host (with
 * `env` merged over `process.env`) for `no_workspace` mode. Normalizes a
 * non-zero exit into a result rather than throwing, since `execFile` throws on
 * non-zero exit but still carries `stdout`/`stderr` on the thrown error — the
 * same shape callers need to build a clear error message either way. The
 * thrown error's own message embeds the `docker exec -e K=V` argv, so `env`
 * values are redacted from it before it can reach a failure payload.
 */
export const defaultRunCodeStepCommand: RunCodeStepCommand = async (
  input,
) => {
  const [executable, args] =
    input.runtimeContainerId === null
      ? (["sh", ["-lc", input.shellCommand]] as const)
      : ([
          "docker",
          [
            "exec",
            ...buildDockerEnvFlags(input.env ?? {}),
            input.runtimeContainerId,
            "sh",
            "-lc",
            input.shellCommand,
          ],
        ] as const);
  const hostEnv =
    input.runtimeContainerId === null && input.env
      ? { ...process.env, ...input.env }
      : undefined;

  try {
    const { stdout, stderr } = await execFileAsync(executable, [...args], {
      ...(hostEnv ? { env: hostEnv } : {}),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const execError = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    return {
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      stdout: execError.stdout ?? "",
      stderr:
        execError.stderr || redactEnvValues(execError.message, input.env),
    };
  }
};

/**
 * Always starts in the workspace folder: `docker exec` and a host shell both
 * begin in whatever directory the image or worker happens to use, which made
 * relative paths in a step function behave differently per environment.
 *
 * A managed step names its runtime, so it is invoked directly. Any other step
 * prefers bun when present and falls back to node. See
 * CODE_STEP_RUNNER_SCRIPT_SOURCE's doc comment for why.
 */
function buildRunnerInvocationScript(input: {
  workspaceFolder: string;
  runtime: CodeStepRuntime | undefined;
  runnerScriptPath: string;
  entrypointPath: string;
  stepKey: string;
  inputFilePath: string;
  findingsFilePath: string;
}): string {
  const runnerArgs = [
    shQuote(input.runnerScriptPath),
    shQuote(input.entrypointPath),
    shQuote(input.stepKey),
    shQuote(input.inputFilePath),
    shQuote(input.findingsFilePath),
  ].join(" ");
  const enterWorkspace = `cd ${shQuote(input.workspaceFolder)} &&`;

  if (input.runtime) {
    const invocation =
      input.runtime === "bun" ? `bun run ${runnerArgs}` : `node ${runnerArgs}`;
    return `${enterWorkspace} ${invocation}`;
  }

  return [
    enterWorkspace,
    "if command -v bun >/dev/null 2>&1; then",
    `bun run ${runnerArgs};`,
    "elif command -v node >/dev/null 2>&1; then",
    `node ${runnerArgs};`,
    "else",
    'echo "boboddy code-step runner: neither bun nor node found in PATH" 1>&2; exit 1;',
    "fi",
  ].join(" ");
}

/**
 * Resolves a workspace-relative path to a host path, refusing one that leaves
 * the workspace: the runner is written and swept at this location.
 */
function resolveInsideWorkspace(
  workspacePath: string,
  relativePath: string,
): string {
  const resolved = path.resolve(workspacePath, relativePath);
  const relative = path.relative(path.resolve(workspacePath), resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Code step source file "${relativePath}" resolves outside the workspace`,
    );
  }
  return resolved;
}

/**
 * Deletes `.code-step-runner-*.mjs` files a crashed run left in `directory`,
 * so a later step cannot commit one with its work. Workspaces are per step
 * execution, so this cannot race a live runner.
 */
async function removeStaleRunners(directory: string): Promise<void> {
  const entries = await readdir(directory);
  await Promise.allSettled(
    entries
      .filter(
        (name) =>
          name.startsWith(CODE_STEP_RUNNER_PREFIX) &&
          name.endsWith(CODE_STEP_RUNNER_SUFFIX),
      )
      .map((name) => rm(path.join(directory, name), { force: true })),
  );
}

/**
 * Runs a `kind: "code"` step's entrypoint against the resolved runtime
 * environment and writes its result to the findings-submission file. Throws
 * with a clear message on any failure (missing export, thrown error, command
 * dispatch failure, etc.) so the caller (`process-claimed-step-execution.ts`)
 * surfaces a real error instead of silently producing no findings.
 */
export async function executeCodeStep(
  input: ExecuteCodeStepInput,
  deps: { runCommand?: RunCodeStepCommand } = {},
): Promise<void> {
  const runCommand = deps.runCommand ?? defaultRunCodeStepCommand;
  const tmpId = createUuidV7();

  const relativeRunnerDir = path.posix.dirname(input.entrypointJson.sourceFile);
  const relativeRunnerScriptPath = path.posix.join(
    relativeRunnerDir,
    `${CODE_STEP_RUNNER_PREFIX}${tmpId}${CODE_STEP_RUNNER_SUFFIX}`,
  );
  const relativeInputFilePath = path.posix.join(
    CODE_STEP_TMP_RELATIVE_DIR,
    `code-step-input-${tmpId}.json`,
  );

  const hostRunnerScriptPath = resolveInsideWorkspace(
    input.environment.workspacePath,
    relativeRunnerScriptPath,
  );
  const hostInputFilePath = path.join(
    input.environment.workspacePath,
    relativeInputFilePath,
  );

  const runnerVisibleRunnerScriptPath = path.posix.join(
    input.environment.workspaceFolder,
    relativeRunnerScriptPath,
  );
  const runnerVisibleInputFilePath = path.posix.join(
    input.environment.workspaceFolder,
    relativeInputFilePath,
  );
  const runnerVisibleEntrypointPath = path.posix.join(
    input.environment.workspaceFolder,
    input.entrypointJson.sourceFile,
  );
  // Reuses `buildFindingsSubmissionPath` verbatim (same convention
  // `process-project-work-findings.ts` already validates/posts), rooted at
  // the runner-visible workspace folder rather than the host workspace path.
  const runnerVisibleFindingsPath = buildFindingsSubmissionPath(
    input.environment.workspaceFolder,
  );

  try {
    await mkdir(path.dirname(hostRunnerScriptPath), { recursive: true });
    await removeStaleRunners(path.dirname(hostRunnerScriptPath));
    await writeFile(
      hostRunnerScriptPath,
      CODE_STEP_RUNNER_SCRIPT_SOURCE,
      "utf8",
    );
    await mkdir(path.dirname(hostInputFilePath), { recursive: true });
    await writeFile(
      hostInputFilePath,
      JSON.stringify(input.inputJson ?? null),
      "utf8",
    );

    const shellCommand = buildRunnerInvocationScript({
      workspaceFolder: input.environment.workspaceFolder,
      runtime: input.runtime,
      runnerScriptPath: runnerVisibleRunnerScriptPath,
      entrypointPath: runnerVisibleEntrypointPath,
      stepKey: input.stepKey,
      inputFilePath: runnerVisibleInputFilePath,
      findingsFilePath: runnerVisibleFindingsPath,
    });

    const result = await runCommand({
      runtimeContainerId: input.environment.runtimeContainerId,
      shellCommand,
      env: input.stepEnv,
    });

    if (result.exitCode !== 0) {
      const details = [result.stderr.trim(), result.stdout.trim()]
        .filter((text) => text.length > 0)
        .join("\n");
      throw new Error(
        `Code step execution failed (exit code ${String(result.exitCode)}) ` +
          `for ${input.entrypointJson.sourceFile} (step "${input.stepKey}")` +
          (details ? `: ${details}` : ""),
      );
    }
  } finally {
    await Promise.allSettled([
      rm(hostRunnerScriptPath, { force: true }),
      rm(hostInputFilePath, { force: true }),
    ]);
  }
}
