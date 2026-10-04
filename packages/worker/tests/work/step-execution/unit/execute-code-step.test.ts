/**
 * Unit tests for {@link executeCodeStep}, the `kind: "code"` step execution
 * shim. Follows the same injectable-command-runner pattern as
 * `process-project-work-monitor-helpers.ts`'s `runDockerExec` seam — no real
 * `docker`/`sh` binary is ever invoked; a fake `runCommand` records the
 * constructed command instead.
 *
 * Coverage:
 *   1. Workspace mode (`runtimeContainerId` set): dispatches via the injected
 *      command runner with the container id, and the constructed shell
 *      command references the runner-visible (`workspaceFolder`-rooted)
 *      paths for the runner script, entrypoint, step key, input file, and
 *      findings file.
 *   2. `no_workspace` mode (`runtimeContainerId: null`): dispatches with a
 *      null container id (host exec), not `docker exec`.
 *   3. Writes the runner script next to the step's module and the input file
 *      to `.boboddy/tmp/` on the HOST workspace path before dispatch, sweeps
 *      stale runners from the module's directory, and always removes both
 *      files afterward — on both the success and failure paths.
 *   4. A non-zero exit from the command runner throws a clear error
 *      surfacing stderr/stdout detail, identifying the failing source file and step key.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  defaultRunCodeStepCommand,
  executeCodeStep,
  type RunCodeStepCommand,
} from "../../../../src/work/step-execution/application/execute-code-step";

describe("executeCodeStep", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-execute-code-step-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  test("dispatches via docker exec for workspace mode and references runner-visible paths", async () => {
    const calls: Array<{
      runtimeContainerId: string | null;
      shellCommand: string;
    }> = [];
    const runCommand: RunCodeStepCommand = (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: "/workspaces/repo",
          runtimeContainerId: "container-123",
        },
        entrypointJson: {
          sourceFile: ".boboddy/pipeline-builder/review-file-step.ts",
        },
        stepKey: "review-file",
        inputJson: { file: "src/index.ts" },
      },
      { runCommand },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.runtimeContainerId).toBe("container-123");
    const shellCommand = call?.shellCommand ?? "";

    // Prefers bun (native TS support), falls back to node.
    expect(shellCommand).toContain("command -v bun");
    expect(shellCommand).toContain("bun run");
    expect(shellCommand).toContain("command -v node");
    expect(shellCommand).toContain("node ");

    // References the runner-visible (workspaceFolder-rooted) entrypoint path.
    expect(shellCommand).toContain(
      "/workspaces/repo/.boboddy/pipeline-builder/review-file-step.ts",
    );
    expect(shellCommand).toContain("'review-file'");
    // Findings submission path matches `buildFindingsSubmissionPath`'s
    // convention, rooted at the runner-visible workspace folder.
    expect(shellCommand).toContain(
      "/workspaces/repo/.boboddy/step-findings-submission.json",
    );
    // The runner sits next to the step's module and the input file in the
    // scratch dir, both rooted at workspaceFolder as seen by the runner.
    expect(shellCommand).toContain(
      "/workspaces/repo/.boboddy/pipeline-builder/.code-step-runner-",
    );
    expect(shellCommand).toContain("/workspaces/repo/.boboddy/tmp/code-step-input-");
    expect(shellCommand).not.toContain(".boboddy/tmp/code-step-runner-");
  });

  test("passes the argv <entrypoint> <stepKey> <input> <findings> after the runner path", async () => {
    const commands: string[] = [];
    const runCommand: RunCodeStepCommand = (input) => {
      commands.push(input.shellCommand);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: "/workspaces/repo",
          runtimeContainerId: "container-123",
        },
        entrypointJson: { sourceFile: "steps/review.ts" },
        stepKey: "it's-a-key",
        inputJson: null,
      },
      { runCommand },
    );

    expect(commands[0]).toMatch(
      /bun run '\/workspaces\/repo\/steps\/\.code-step-runner-[^']+\.mjs' '\/workspaces\/repo\/steps\/review\.ts' 'it'\\''s-a-key' '\/workspaces\/repo\/\.boboddy\/tmp\/code-step-input-[^']+\.json' '\/workspaces\/repo\/\.boboddy\/step-findings-submission\.json'/,
    );
  });

  test("dispatches with a null container id for no_workspace mode (host exec, no docker)", async () => {
    const calls: Array<{ runtimeContainerId: string | null }> = [];
    const runCommand: RunCodeStepCommand = (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: workspacePath,
          runtimeContainerId: null,
        },
        entrypointJson: { sourceFile: "steps/review.ts" },
        stepKey: "review-step",
        inputJson: null,
      },
      { runCommand },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.runtimeContainerId).toBeNull();
  });

  test("passes stepEnv to the command runner as env, never inside the shell command", async () => {
    const calls: Array<Parameters<RunCodeStepCommand>[0]> = [];
    const runCommand: RunCodeStepCommand = (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    for (const runtimeContainerId of ["container-123", null]) {
      await executeCodeStep(
        {
          environment: {
            workspacePath,
            workspaceFolder: "/workspaces/repo",
            runtimeContainerId,
          },
          entrypointJson: { sourceFile: "steps/review.ts" },
          stepKey: "review-step",
          inputJson: null,
          stepEnv: { ACCOUNT_ID: "acct-1", WAREHOUSE_TOKEN: "wh-token-value" },
        },
        { runCommand },
      );
    }

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.env).toEqual({
        ACCOUNT_ID: "acct-1",
        WAREHOUSE_TOKEN: "wh-token-value",
      });
      expect(call.shellCommand).not.toContain("wh-token-value");
      expect(call.shellCommand).not.toContain("acct-1");
    }
  });

  test("omits env when the step declares none", async () => {
    const calls: Array<Parameters<RunCodeStepCommand>[0]> = [];
    const runCommand: RunCodeStepCommand = (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: workspacePath,
          runtimeContainerId: null,
        },
        entrypointJson: { sourceFile: "steps/review.ts" },
        stepKey: "review-step",
        inputJson: null,
      },
      { runCommand },
    );

    expect(calls[0]?.env).toBeUndefined();
  });

  test("writes the runner script next to the step's module and the input file to .boboddy/tmp before dispatch, and removes them after success", async () => {
    let runnerFilesDuringDispatch: string[] = [];
    let inputFilesDuringDispatch: string[] = [];
    const runCommand: RunCodeStepCommand = async (input) => {
      void input;
      runnerFilesDuringDispatch = await readdir(
        path.join(workspacePath, "steps"),
      );
      inputFilesDuringDispatch = await readdir(
        path.join(workspacePath, ".boboddy", "tmp"),
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: workspacePath,
          runtimeContainerId: null,
        },
        entrypointJson: { sourceFile: "steps/review.ts" },
        stepKey: "review-step",
        inputJson: { a: 1 },
      },
      { runCommand },
    );

    // Both files existed at dispatch time...
    expect(runnerFilesDuringDispatch).toHaveLength(1);
    expect(runnerFilesDuringDispatch[0]).toMatch(
      /^\.code-step-runner-.+\.mjs$/,
    );
    expect(
      inputFilesDuringDispatch.some((name) =>
        name.startsWith("code-step-input-"),
      ),
    ).toBe(true);
    expect(
      inputFilesDuringDispatch.some((name) =>
        name.startsWith("code-step-runner-"),
      ),
    ).toBe(false);

    // ...and are cleaned up afterward.
    expect(await readdir(path.join(workspacePath, "steps"))).toEqual([]);
    expect(
      await readdir(path.join(workspacePath, ".boboddy", "tmp")),
    ).toHaveLength(0);
  });

  test("throws a clear error and still cleans up temp files when the command exits non-zero", async () => {
    const runCommand: RunCodeStepCommand = () =>
      Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: 'no code step with key "review-file" exported by or embedded in x',
      });

    let caught: unknown;
    try {
      await executeCodeStep(
        {
          environment: {
            workspacePath,
            workspaceFolder: workspacePath,
            runtimeContainerId: null,
          },
          entrypointJson: { sourceFile: "steps/review.ts" },
          stepKey: "review-file",
          inputJson: null,
        },
        { runCommand },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("exit code 1");
    expect((caught as Error).message).toContain(
      'for steps/review.ts (step "review-file")',
    );
    expect((caught as Error).message).toContain(
      'no code step with key "review-file" exported by or embedded in x',
    );

    expect(
      await readdir(path.join(workspacePath, ".boboddy", "tmp")),
    ).toHaveLength(0);
    expect(await readdir(path.join(workspacePath, "steps"))).toEqual([]);
  });

  test("input JSON is written to the input temp file so the runner can read it back", async () => {
    const capturedInputFileContents: string[] = [];
    const runCommand: RunCodeStepCommand = async () => {
      const tmpDir = path.join(workspacePath, ".boboddy", "tmp");
      const files = await readdir(tmpDir);
      const inputFile = files.find((name) => name.startsWith("code-step-input-"));
      if (inputFile) {
        capturedInputFileContents.push(
          await readFile(path.join(tmpDir, inputFile), "utf8"),
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: workspacePath,
          runtimeContainerId: null,
        },
        entrypointJson: { sourceFile: "steps/review.ts" },
        stepKey: "review-step",
        inputJson: { file: "src/index.ts", priority: "high" },
      },
      { runCommand },
    );

    expect(capturedInputFileContents).toHaveLength(1);
    expect(JSON.parse(capturedInputFileContents[0] ?? "null")).toEqual({
      file: "src/index.ts",
      priority: "high",
    });
  });

  test("the runner script file exists at dispatch time and contains the expected dynamic-import shape", async () => {
    const capturedRunnerScriptContents: string[] = [];
    const runCommand: RunCodeStepCommand = async () => {
      const runnerDir = path.join(workspacePath, "steps");
      const files = await readdir(runnerDir);
      const runnerFile = files.find((name) =>
        name.startsWith(".code-step-runner-"),
      );
      if (runnerFile) {
        capturedRunnerScriptContents.push(
          await readFile(path.join(runnerDir, runnerFile), "utf8"),
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: workspacePath,
          runtimeContainerId: null,
        },
        entrypointJson: { sourceFile: "steps/review.ts" },
        stepKey: "review-step",
        inputJson: null,
      },
      { runCommand },
    );

    expect(capturedRunnerScriptContents).toHaveLength(1);
    const runnerScriptContent = capturedRunnerScriptContents[0] ?? "";
    expect(runnerScriptContent).toContain("import(entrypointPath)");
    expect(runnerScriptContent).toContain(
      'import("@boboddy/sdk/code-step-lookup")',
    );
    expect(runnerScriptContent).toContain("findingsJson");

    expect(await readdir(path.join(workspacePath, "steps"))).toEqual([]);
  });
});

describe("defaultRunCodeStepCommand", () => {
  test("exposes env to a host process, merged over the worker's own env", async () => {
    process.env["STEP_ENV_AMBIENT_PROBE"] = "from-worker";
    try {
      const result = await defaultRunCodeStepCommand({
        runtimeContainerId: null,
        shellCommand: 'printf "%s|%s" "$STEP_ENV_PROBE" "$STEP_ENV_AMBIENT_PROBE"',
        env: { STEP_ENV_PROBE: "from-step" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("from-step|from-worker");
    } finally {
      delete process.env["STEP_ENV_AMBIENT_PROBE"];
    }
  });

  test("leaves the host env untouched when no env is given", async () => {
    const result = await defaultRunCodeStepCommand({
      runtimeContainerId: null,
      shellCommand: 'printf "%s" "${STEP_ENV_PROBE:-unset}"',
    });

    expect(result.stdout).toBe("unset");
  });
});
