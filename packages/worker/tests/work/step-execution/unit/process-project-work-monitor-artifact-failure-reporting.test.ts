import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { collectStepArtifacts } from "../../../../src/work/step-execution/application/process-project-work-monitor-helpers";
import {
  createDeps,
  createStartedExecution,
} from "./helpers/process-project-work-monitor-artifacts-fixtures";

/**
 * Split out from `process-project-work-monitor-artifacts.test.ts` (which
 * covers the surrounding `monitorStartedClaimedExecution` orchestration) so
 * neither file has to duplicate shared fixtures and both stay under the
 * repo's per-file line limit. See `helpers/process-project-work-monitor-artifacts-fixtures.ts`.
 */
describe("collectStepArtifacts failure reporting", () => {
  const fakeLogger = () => ({
    debug: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
  });

  test.concurrent(
    "reports a classified artifact-save failure to the worker",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-collect-artifacts-failure-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
      const stepArtifactsDir = path.join(
        workspacePath,
        ".boboddy",
        "step-artifacts",
      );
      await mkdir(stepArtifactsDir, { recursive: true });
      await writeFile(
        path.join(stepArtifactsDir, "notes.txt"),
        "hello world",
        "utf8",
      );

      const saveArtifact = vi.fn(() =>
        Promise.reject(
          new Error(
            JSON.stringify({
              type: "about:blank",
              title: "Insufficient Storage",
              status: 507,
              code: "USAGE_LIMIT_EXCEEDED_STORAGE",
              detail: "Storage limit exceeded.",
            }),
          ),
        ),
      );
      const recordArtifactFailure = vi.fn(() => Promise.resolve(undefined));

      const deps = createDeps({
        callOrder: [],
        saveArtifact,
        completeStepExecution: vi.fn(),
        finalStepStatus: "succeeded",
        getSessionStatus: vi.fn(),
        recordArtifactFailure,
      });

      await collectStepArtifacts(deps, startedExecution, fakeLogger());

      expect(recordArtifactFailure).toHaveBeenCalledTimes(1);
      expect(recordArtifactFailure).toHaveBeenCalledWith({
        stepExecutionId: startedExecution.stepExecutionId,
        claimToken: startedExecution.claimToken,
        relativeStorePath: "notes.txt",
        attemptedSizeBytes: "hello world".length,
        kind: "generic",
        errorCode: "USAGE_LIMIT_EXCEEDED_STORAGE",
        errorMessage: "Storage limit exceeded.",
        httpStatus: 507,
      });
    },
  );

  test.concurrent(
    "never lets a recordArtifactFailure rejection escape collectStepArtifacts",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-collect-artifacts-failure-reporting-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
      const stepArtifactsDir = path.join(
        workspacePath,
        ".boboddy",
        "step-artifacts",
      );
      await mkdir(stepArtifactsDir, { recursive: true });
      await writeFile(
        path.join(stepArtifactsDir, "notes.txt"),
        "hello world",
        "utf8",
      );

      const saveArtifact = vi.fn(() =>
        Promise.reject(new Error("network unreachable")),
      );
      const recordArtifactFailure = vi.fn(() =>
        Promise.reject(new Error("reporting endpoint down")),
      );

      const deps = createDeps({
        callOrder: [],
        saveArtifact,
        completeStepExecution: vi.fn(),
        finalStepStatus: "succeeded",
        getSessionStatus: vi.fn(),
        recordArtifactFailure,
      });

      let thrown: unknown;
      try {
        await collectStepArtifacts(deps, startedExecution, fakeLogger());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(recordArtifactFailure).toHaveBeenCalledTimes(1);
    },
  );
});
