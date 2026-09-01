/**
 * Executes a `kind: "code"` step definition's entrypoint — a plain function
 * living in the target repo's own checkout — instead of prompting an AI
 * agent. See docs/research/flat-pipeline-sdk-and-visual-designer.md §7.7/§9.
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
 * The runner script dynamically `import()`s the resolved entrypoint module,
 * calls the named export with the parsed input JSON, and writes the result to
 * `.boboddy/step-findings-submission.json` in the exact shape the OpenCode
 * plugin's `boboddy-submit-step-findings` tool already writes (see
 * `buildFindingsSubmissionPath` / `process-project-work-findings.ts`, reused
 * here verbatim) — the downstream `tryPersistAgentFindings` path needs zero
 * changes, since it is already agnostic to how `resultJson` was produced.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createUuidV7 } from "../../../common/contracts/uuid-v7";
import { buildFindingsSubmissionPath } from "./process-project-work-findings";
import { shQuote } from "./process-project-work-monitor-helpers";

const execFileAsync = promisify(execFile);

/** Relative (POSIX) location under the workspace root for code-step scratch files. */
const CODE_STEP_TMP_RELATIVE_DIR = ".boboddy/tmp";

export type CodeStepEntrypoint = {
  sourceFile: string;
  exportName: string;
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
  inputJson: unknown;
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
}) => Promise<RunCodeStepCommandResult>;

/**
 * Default command runner: `docker exec <containerId> sh -lc "<cmd>"` for
 * workspace mode, a plain `sh -lc "<cmd>"` on the host for `no_workspace`
 * mode. Normalizes a non-zero exit into a result rather than throwing, since
 * `execFile` throws on non-zero exit but still carries `stdout`/`stderr` on
 * the thrown error — the same shape callers need to build a clear error
 * message either way.
 */
export const defaultRunCodeStepCommand: RunCodeStepCommand = async (
  input,
) => {
  const [executable, args] =
    input.runtimeContainerId === null
      ? (["sh", ["-lc", input.shellCommand]] as const)
      : ([
          "docker",
          ["exec", input.runtimeContainerId, "sh", "-lc", input.shellCommand],
        ] as const);

  try {
    const { stdout, stderr } = await execFileAsync(executable, [...args]);
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
      stderr: execError.stderr || execError.message,
    };
  }
};

/**
 * The runner script executed inside the workspace. Written as a standalone
 * `.mjs` file (no external deps) so it works verbatim under either `bun` or
 * `node`'s ESM loader. Prefers `bun` when present because code-step
 * entrypoints are typically authored in TypeScript (the same
 * `.boboddy/pipeline-builder/*.ts` files `@boboddy/sdk` collects them from —
 * see decision 7) and `bun`'s `import()` handles `.ts` natively; a devcontainer
 * that only has plain `node` (no TS loader) will surface a clear import error
 * for a `.ts` entrypoint, which is the same "clear stderr message" failure
 * mode required for a missing export or a thrown error.
 *
 * argv: `<entrypointAbsPath> <exportName> <inputFileAbsPath> <findingsFileAbsPath>`.
 */
const CODE_STEP_RUNNER_SCRIPT_SOURCE = `
import { readFile, writeFile } from "node:fs/promises";

async function main() {
  const [, , entrypointPath, exportName, inputFilePath, findingsFilePath] = process.argv;
  if (!entrypointPath || !exportName || !inputFilePath || !findingsFilePath) {
    console.error("boboddy code-step runner: missing required arguments");
    process.exitCode = 1;
    return;
  }

  let inputJson;
  try {
    const rawInput = await readFile(inputFilePath, "utf8");
    inputJson = JSON.parse(rawInput);
  } catch (error) {
    console.error(
      \`boboddy code-step runner: failed to read/parse input file at \${inputFilePath}: \${
        error instanceof Error ? error.message : String(error)
      }\`,
    );
    process.exitCode = 1;
    return;
  }

  let mod;
  try {
    mod = await import(entrypointPath);
  } catch (error) {
    console.error(
      \`boboddy code-step runner: failed to import entrypoint module at \${entrypointPath}: \${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\`,
    );
    process.exitCode = 1;
    return;
  }

  const fn = mod[exportName];
  if (typeof fn !== "function") {
    console.error(
      \`boboddy code-step runner: module at \${entrypointPath} has no exported function named "\${exportName}"\`,
    );
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await fn(inputJson);
  } catch (error) {
    console.error(
      \`boboddy code-step runner: code step function "\${exportName}" threw: \${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await writeFile(
      findingsFilePath,
      \`\${JSON.stringify({ findingsJson: result === undefined ? null : result }, null, 2)}\\n\`,
      "utf8",
    );
  } catch (error) {
    console.error(
      \`boboddy code-step runner: failed to write findings submission to \${findingsFilePath}: \${
        error instanceof Error ? error.message : String(error)
      }\`,
    );
    process.exitCode = 1;
  }
}

await main();
`;

function buildRunnerInvocationScript(input: {
  runnerScriptPath: string;
  entrypointPath: string;
  exportName: string;
  inputFilePath: string;
  findingsFilePath: string;
}): string {
  const runnerArgs = [
    shQuote(input.runnerScriptPath),
    shQuote(input.entrypointPath),
    shQuote(input.exportName),
    shQuote(input.inputFilePath),
    shQuote(input.findingsFilePath),
  ].join(" ");

  // Prefer bun (native TS support) when present; fall back to node otherwise.
  // See CODE_STEP_RUNNER_SCRIPT_SOURCE's doc comment for why.
  return [
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

  const relativeRunnerScriptPath = path.posix.join(
    CODE_STEP_TMP_RELATIVE_DIR,
    `code-step-runner-${tmpId}.mjs`,
  );
  const relativeInputFilePath = path.posix.join(
    CODE_STEP_TMP_RELATIVE_DIR,
    `code-step-input-${tmpId}.json`,
  );

  const hostRunnerScriptPath = path.join(
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

  await mkdir(path.dirname(hostRunnerScriptPath), { recursive: true });
  await writeFile(hostRunnerScriptPath, CODE_STEP_RUNNER_SCRIPT_SOURCE, "utf8");
  await writeFile(
    hostInputFilePath,
    JSON.stringify(input.inputJson ?? null),
    "utf8",
  );

  try {
    const shellCommand = buildRunnerInvocationScript({
      runnerScriptPath: runnerVisibleRunnerScriptPath,
      entrypointPath: runnerVisibleEntrypointPath,
      exportName: input.entrypointJson.exportName,
      inputFilePath: runnerVisibleInputFilePath,
      findingsFilePath: runnerVisibleFindingsPath,
    });

    const result = await runCommand({
      runtimeContainerId: input.environment.runtimeContainerId,
      shellCommand,
    });

    if (result.exitCode !== 0) {
      const details = [result.stderr.trim(), result.stdout.trim()]
        .filter((text) => text.length > 0)
        .join("\n");
      throw new Error(
        `Code step execution failed (exit code ${String(result.exitCode)}) ` +
          `for entrypoint ${input.entrypointJson.sourceFile}#${input.entrypointJson.exportName}` +
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
