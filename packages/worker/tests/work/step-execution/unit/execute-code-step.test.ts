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
 *      paths for the runner script, entrypoint, input file, and findings file.
 *   2. `no_workspace` mode (`runtimeContainerId: null`): dispatches with a
 *      null container id (host exec), not `docker exec`.
 *   3. Writes the runner script + input file to the HOST workspace path
 *      before dispatch, and always removes them afterward — on both the
 *      success and failure paths.
 *   4. A non-zero exit from the command runner throws a clear error
 *      surfacing stderr/stdout detail, identifying the failing entrypoint.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
          exportName: "reviewFileStep",
        },
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
    expect(shellCommand).toContain("reviewFileStep");
    // Findings submission path matches `buildFindingsSubmissionPath`'s
    // convention, rooted at the runner-visible workspace folder.
    expect(shellCommand).toContain(
      "/workspaces/repo/.boboddy/step-findings-submission.json",
    );
    // The runner script + input file both live under a workspace-relative
    // scratch dir, rooted at workspaceFolder as seen by the runner.
    expect(shellCommand).toContain("/workspaces/repo/.boboddy/tmp/code-step-runner-");
    expect(shellCommand).toContain("/workspaces/repo/.boboddy/tmp/code-step-input-");
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
        entrypointJson: { sourceFile: "steps/review.ts", exportName: "review" },
        inputJson: null,
      },
      { runCommand },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.runtimeContainerId).toBeNull();
  });

  test("writes the runner script + input file to the host workspace path before dispatch, and removes them after success", async () => {
    let writtenFilesDuringDispatch: string[] = [];
    const runCommand: RunCodeStepCommand = async (input) => {
      void input;
      const tmpDir = path.join(workspacePath, ".boboddy", "tmp");
      try {
        writtenFilesDuringDispatch = await readdir(tmpDir);
      } catch {
        writtenFilesDuringDispatch = [];
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
        entrypointJson: { sourceFile: "steps/review.ts", exportName: "review" },
        inputJson: { a: 1 },
      },
      { runCommand },
    );

    // Both temp files existed at dispatch time...
    expect(
      writtenFilesDuringDispatch.some((name) =>
        name.startsWith("code-step-runner-"),
      ),
    ).toBe(true);
    expect(
      writtenFilesDuringDispatch.some((name) =>
        name.startsWith("code-step-input-"),
      ),
    ).toBe(true);

    // ...and are cleaned up afterward.
    const tmpDirEntries = await readdir(
      path.join(workspacePath, ".boboddy", "tmp"),
    );
    expect(tmpDirEntries).toHaveLength(0);
  });

  test("throws a clear error and still cleans up temp files when the command exits non-zero", async () => {
    const runCommand: RunCodeStepCommand = () =>
      Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: 'module has no exported function named "reviewFileStep"',
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
          entrypointJson: {
            sourceFile: "steps/review.ts",
            exportName: "reviewFileStep",
          },
          inputJson: null,
        },
        { runCommand },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("exit code 1");
    expect((caught as Error).message).toContain("steps/review.ts");
    expect((caught as Error).message).toContain("reviewFileStep");
    expect((caught as Error).message).toContain(
      'module has no exported function named "reviewFileStep"',
    );

    const tmpDirEntries = await readdir(
      path.join(workspacePath, ".boboddy", "tmp"),
    );
    expect(tmpDirEntries).toHaveLength(0);
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
        entrypointJson: { sourceFile: "steps/review.ts", exportName: "review" },
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
      const tmpDir = path.join(workspacePath, ".boboddy", "tmp");
      const files = await readdir(tmpDir);
      const runnerFile = files.find((name) =>
        name.startsWith("code-step-runner-"),
      );
      if (runnerFile) {
        capturedRunnerScriptContents.push(
          await readFile(path.join(tmpDir, runnerFile), "utf8"),
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
        entrypointJson: { sourceFile: "steps/review.ts", exportName: "review" },
        inputJson: null,
      },
      { runCommand },
    );

    expect(capturedRunnerScriptContents).toHaveLength(1);
    const runnerScriptContent = capturedRunnerScriptContents[0] ?? "";
    expect(runnerScriptContent).toContain("import(entrypointPath)");
    expect(runnerScriptContent).toContain("findingsJson");

    // The runner/input files themselves are removed right after dispatch
    // resolves (the scratch dir stays — only its contents are cleaned up),
    // but we already captured the content above while they were live.
    const remainingTmpEntries = await readdir(
      path.join(workspacePath, ".boboddy", "tmp"),
    );
    expect(remainingTmpEntries).toHaveLength(0);
  });
});
