/**
 * Where {@link executeCodeStep} puts the runner script, through the
 * injectable `runCommand` seam (no real `docker`/`sh`):
 *   - it is written next to the step's module as `.code-step-runner-<uuid>.mjs`,
 *     so its bare `@boboddy/sdk/code-step-lookup` import resolves like the
 *     module's own imports;
 *   - stale runners left by a crash are swept from that directory before the
 *     new one is written, and nothing else is touched;
 *   - it is removed after both a successful and a failing run;
 *   - a source file that resolves outside the workspace is refused before
 *     anything is written or dispatched.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  executeCodeStep,
  type RunCodeStepCommand,
} from "../../../../src/work/step-execution/application/execute-code-step";

describe("executeCodeStep runner placement", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-execute-code-step-placement-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  function run(
    sourceFile: string,
    runCommand: RunCodeStepCommand,
  ): Promise<void> {
    return executeCodeStep(
      {
        environment: {
          workspacePath,
          workspaceFolder: workspacePath,
          runtimeContainerId: null,
        },
        entrypointJson: { sourceFile },
        stepKey: "review-step",
        inputJson: null,
      },
      { runCommand },
    );
  }

  test("sweeps stale runners from the module's directory and leaves every other file alone", async () => {
    const stepsDir = path.join(workspacePath, "steps");
    await mkdir(stepsDir, { recursive: true });
    await writeFile(path.join(stepsDir, ".code-step-runner-stale-1.mjs"), "");
    await writeFile(path.join(stepsDir, ".code-step-runner-stale-2.mjs"), "");
    await writeFile(path.join(stepsDir, "review.ts"), "export {};");
    await writeFile(path.join(stepsDir, "code-step-runner-visible.mjs"), "");
    await writeFile(path.join(stepsDir, ".code-step-runner-notes.txt"), "");
    const otherDir = path.join(workspacePath, "other");
    await mkdir(otherDir, { recursive: true });
    await writeFile(path.join(otherDir, ".code-step-runner-elsewhere.mjs"), "");

    let duringDispatch: string[] = [];
    await run("steps/review.ts", async () => {
      duringDispatch = await readdir(stepsDir);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const liveRunners = duringDispatch.filter((name) =>
      /^\.code-step-runner-.+\.mjs$/.test(name),
    );
    expect(liveRunners).toHaveLength(1);
    expect(liveRunners[0]).not.toContain("stale");
    expect(duringDispatch).toContain("review.ts");
    expect(duringDispatch).toContain("code-step-runner-visible.mjs");
    expect(duringDispatch).toContain(".code-step-runner-notes.txt");

    expect((await readdir(stepsDir)).sort()).toEqual([
      ".code-step-runner-notes.txt",
      "code-step-runner-visible.mjs",
      "review.ts",
    ]);
    expect(await readdir(otherDir)).toEqual([
      ".code-step-runner-elsewhere.mjs",
    ]);
  });

  test("writes the runner into the workspace root for a module at the repo root", async () => {
    let duringDispatch: string[] = [];
    await run("review.ts", async () => {
      duringDispatch = await readdir(workspacePath);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    expect(
      duringDispatch.some((name) => /^\.code-step-runner-.+\.mjs$/.test(name)),
    ).toBe(true);
    expect(
      (await readdir(workspacePath)).filter((name) =>
        name.startsWith(".code-step-runner-"),
      ),
    ).toEqual([]);
  });

  test("removes the runner next to the module after a failing run too", async () => {
    let caught: unknown;
    try {
      await run(".boboddy/pipeline-builder/review.ts", () =>
        Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom" }),
      );
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain("boom");
    expect(
      await readdir(path.join(workspacePath, ".boboddy", "pipeline-builder")),
    ).toEqual([]);
  });

  test("removes the runner when the command runner itself rejects", async () => {
    let caught: unknown;
    try {
      await run("steps/review.ts", () =>
        Promise.reject(new Error("docker unavailable")),
      );
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toBe("docker unavailable");
    expect(await readdir(path.join(workspacePath, "steps"))).toEqual([]);
  });

  test("refuses a source file that resolves outside the workspace without dispatching", async () => {
    const calls: string[] = [];
    let caught: unknown;
    try {
      await run("../escape/review.ts", (input) => {
        calls.push(input.shellCommand);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain(
      "resolves outside the workspace",
    );
    expect(calls).toEqual([]);
  });
});
