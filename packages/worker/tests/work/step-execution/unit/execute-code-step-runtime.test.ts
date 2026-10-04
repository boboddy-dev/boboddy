/**
 * How {@link executeCodeStep} picks the runtime and where it starts the runner,
 * through the injectable `runCommand` seam (no real `docker`/`sh`):
 *   - a managed step names its runtime, which is invoked directly with no
 *     `PATH` sniffing;
 *   - any other step keeps sniffing bun, then node;
 *   - every step starts in the workspace folder, so relative paths in a step
 *     function do not depend on the image's `WORKDIR`.
 * The last test runs the real default runner on the host: a missing workspace
 * folder fails the step, proving the `cd` takes effect.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  executeCodeStep,
  type CodeStepRuntime,
  type RunCodeStepCommand,
} from "../../../../src/work/step-execution/application/execute-code-step";

describe("executeCodeStep runtime and working directory", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-execute-code-step-runtime-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function shellCommandFor(input: {
    runtime?: CodeStepRuntime;
    runtimeContainerId?: string | null;
    workspaceFolder?: string;
  }): Promise<string> {
    const commands: string[] = [];
    const runCommand: RunCodeStepCommand = (call) => {
      commands.push(call.shellCommand);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    await executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: input.workspaceFolder ?? "/workspaces/repo",
          runtimeContainerId: input.runtimeContainerId ?? "container-123",
        },
        entrypointJson: { sourceFile: "steps/review.ts" },
        stepKey: "review-step",
        inputJson: null,
        runtime: input.runtime,
      },
      { runCommand },
    );
    return commands[0] ?? "";
  }

  test("a bun runtime is invoked directly, with no PATH sniffing", async () => {
    const shellCommand = await shellCommandFor({ runtime: "bun" });

    expect(shellCommand).toContain(
      "&& bun run '/workspaces/repo/steps/.code-step-runner-",
    );
    expect(shellCommand).not.toContain("command -v");
    expect(shellCommand).not.toContain("node ");
  });

  test("a node runtime is invoked directly, with no PATH sniffing", async () => {
    const shellCommand = await shellCommandFor({ runtime: "node" });

    expect(shellCommand).toContain("&& node '/workspaces/repo/steps/.code-step-runner-");
    expect(shellCommand).not.toContain("command -v");
    expect(shellCommand).not.toContain("bun run");
  });

  test("without a runtime the step keeps sniffing bun, then node", async () => {
    const shellCommand = await shellCommandFor({});

    expect(shellCommand).toContain("command -v bun");
    expect(shellCommand).toContain("command -v node");
    expect(shellCommand.indexOf("command -v bun")).toBeLessThan(
      shellCommand.indexOf("command -v node"),
    );
  });

  test.each<CodeStepRuntime | undefined>(["bun", "node", undefined])(
    "starts in the workspace folder for runtime %p",
    async (runtime) => {
      const shellCommand = await shellCommandFor({
        runtime,
        workspaceFolder: "/workspaces/repo",
      });

      expect(shellCommand.startsWith("cd '/workspaces/repo' && ")).toBe(true);
    },
  );

  test("starts in the workspace folder for a host run too", async () => {
    const shellCommand = await shellCommandFor({
      runtimeContainerId: null,
      workspaceFolder: workspacePath,
    });

    expect(shellCommand.startsWith(`cd '${workspacePath}' && `)).toBe(true);
  });

  test("quotes a workspace folder containing a single quote", async () => {
    const shellCommand = await shellCommandFor({
      workspaceFolder: "/workspaces/it's",
    });

    expect(shellCommand.startsWith("cd '/workspaces/it'\\''s' && ")).toBe(true);
  });

  test("a workspace folder that does not exist fails the step with the shell's error", async () => {
    const missing = path.join(workspacePath, "missing");

    let caught: unknown;
    try {
      await executeCodeStep({
        environment: {
          workspacePath,
          workspaceFolder: missing,
          runtimeContainerId: null,
        },
        entrypointJson: { sourceFile: "steps/review.ts" },
        stepKey: "review-step",
        inputJson: null,
        runtime: "node",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Code step execution failed");
    expect((caught as Error).message).toContain(missing);
  });
});
