import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import {
  buildCurrentExecutionInfoPath,
  buildFindingsSubmissionPath,
  tryPersistAgentFindings,
  writeCurrentExecutionInfoFile,
} from "../../../../src/work/step-execution/application/process-project-work-findings";
import type {
  ProcessProjectWorkDeps,
  StartedClaimedExecution,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";

function createStartedExecution(
  workspacePath: string,
  overrides?: {
    workBranch?: string | null;
    createdFromBranch?: string | null;
    commitAndPushWorkBranch?: (() => Promise<void>) | undefined;
  },
): StartedClaimedExecution {
  const started = createBaseStartedExecution(workspacePath);
  return {
    ...started,
    environment: {
      ...started.environment,
      workBranch: overrides?.workBranch ?? started.environment.workBranch,
      createdFromBranch:
        overrides?.createdFromBranch ?? started.environment.createdFromBranch,
      commitAndPushWorkBranch: overrides?.commitAndPushWorkBranch,
    },
  };
}

function createBaseStartedExecution(
  workspacePath: string,
): StartedClaimedExecution {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    stepExecutionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003"),
    claimToken: "claim-token",
    agentSessionId: "agent-session-id",
    environment: {
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      opencodeLogDirectory: path.join(workspacePath, ".logs"),
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agentBaseUrl: "http://localhost:4096",
      aiImage: "boboddy/ai-worker:local",
      networkName: "test-network",
      secretValues: [],
      cleanup: () => Promise.resolve(),
    },
  };
}

function createDeps(
  completeStepExecution: ProcessProjectWorkDeps["workerClient"]["completeStepExecution"],
): ProcessProjectWorkDeps {
  return {
    workerClient: {
      userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
      claimStepExecutions: vi.fn(),
      heartbeatStepExecution: vi.fn(),
      failStepExecution: vi.fn(),
      completeStepExecution,
      appendStepExecutionLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
      getStepExecution: vi.fn(),
      getStepExecutionWorkerContext: vi.fn(),
      createArtifactUploadUrl: vi.fn(),
      recordArtifact: vi.fn(),
    },
    createRunTracker: vi.fn(),
    runtimeEnvironmentOrchestrator: {
      launch: vi.fn(),
    },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: vi.fn(),
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: {
      saveArtifact: vi.fn(),
    },
    sleep: vi.fn(),
  };
}

describe("processProjectWork findings persistence", () => {
  test.concurrent(
    "writes current execution metadata and gitignore into .boboddy/current-execution",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-current-execution-"),
      );

      const currentExecutionInfoPath = await writeCurrentExecutionInfoFile(workspacePath, {
        stepExecutionId: "step-execution-id",
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string" },
          },
        },
      });

      expect(currentExecutionInfoPath).toBe(
        buildCurrentExecutionInfoPath(workspacePath),
      );

      expect(
        JSON.parse(
          await readFile(buildCurrentExecutionInfoPath(workspacePath), "utf8"),
        ),
      ).toEqual({
        stepExecutionId: "step-execution-id",
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string" },
          },
        },
      });
      expect(
        await readFile(
          path.join(workspacePath, ".boboddy/current-execution/.gitignore"),
          "utf8",
        ),
      ).toBe("*\n.*\n!.gitignore\n");
    },
  );

  test.concurrent(
    "completes the step when findings match the stored current execution schema",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-findings-submit-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
      const completeStepExecution = vi.fn(() => Promise.resolve(undefined));

      await writeCurrentExecutionInfoFile(workspacePath, {
        stepExecutionId: startedExecution.stepExecutionId,
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
          },
        },
      });
      await writeFile(
        buildFindingsSubmissionPath(workspacePath),
        `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
        "utf8",
      );

      const result = await tryPersistAgentFindings(
        createDeps(completeStepExecution),
        startedExecution,
      );

      expect(result).toBe("submitted");
      expect(completeStepExecution).toHaveBeenCalledWith({
        stepExecutionId: startedExecution.stepExecutionId,
        claimToken: startedExecution.claimToken,
        resultJson: { summary: "done" },
        errorJson: null,
        // Branch-per-step fields are sent as dedicated fields; null here since
        // the fixture env has no work branch.
        workBranch: null,
        createdFromBranch: null,
      });
      const submissionStillExists = await access(
        buildFindingsSubmissionPath(workspacePath),
      )
        .then(() => true)
        .catch(() => false);
      expect(submissionStillExists).toBe(false);
    },
  );

  test.concurrent(
    "throws when findings are submitted without current execution metadata",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-findings-missing-metadata-"),
      );
      const startedExecution = createStartedExecution(workspacePath);
      await mkdir(path.dirname(buildFindingsSubmissionPath(workspacePath)), {
        recursive: true,
      });

      await writeFile(
        buildFindingsSubmissionPath(workspacePath),
        `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
        "utf8",
      );

      try {
        await tryPersistAgentFindings(
          createDeps(vi.fn(() => Promise.resolve(undefined))),
          startedExecution,
        );
        throw new Error("Expected missing current execution metadata to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "Current execution metadata file not found",
        );
      }
    },
  );

  test.concurrent(
    "commits + pushes the work branch (via onBeforeComplete) BEFORE completing, and forwards the branch fields",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-findings-branch-"),
      );
      const order: string[] = [];
      const commitAndPushWorkBranch = vi.fn(() => {
        order.push("commitAndPush");
        return Promise.resolve();
      });
      const startedExecution = createStartedExecution(workspacePath, {
        workBranch: "boboddy/step-abc",
        createdFromBranch: "main",
        commitAndPushWorkBranch,
      });
      const completeStepExecution = vi.fn(() => {
        order.push("complete");
        return Promise.resolve(undefined);
      });

      await writeCurrentExecutionInfoFile(workspacePath, {
        stepExecutionId: startedExecution.stepExecutionId,
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          additionalProperties: false,
          properties: { summary: { type: "string" } },
        },
      });
      await writeFile(
        buildFindingsSubmissionPath(workspacePath),
        `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
        "utf8",
      );

      const result = await tryPersistAgentFindings(
        createDeps(completeStepExecution),
        startedExecution,
        {
          onBeforeComplete: async () => {
            await startedExecution.environment.commitAndPushWorkBranch?.();
          },
        },
      );

      expect(result).toBe("submitted");
      // The commit/push ran while the workspace still existed and the step was
      // still "running" — i.e. strictly before completion.
      expect(order).toEqual(["commitAndPush", "complete"]);
      expect(commitAndPushWorkBranch).toHaveBeenCalledTimes(1);
      expect(completeStepExecution).toHaveBeenCalledWith({
        stepExecutionId: startedExecution.stepExecutionId,
        claimToken: startedExecution.claimToken,
        resultJson: { summary: "done" },
        errorJson: null,
        workBranch: "boboddy/step-abc",
        createdFromBranch: "main",
      });
    },
  );

  test.concurrent(
    "push failure does not fail the step: the swallowing commit/push closure still completes",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-findings-push-fail-"),
      );
      // The production closure swallows push failures; simulate that contract
      // here — a closure that internally handled a failed push and resolves.
      const commitAndPushWorkBranch = vi.fn(() => Promise.resolve());
      const startedExecution = createStartedExecution(workspacePath, {
        workBranch: "boboddy/step-xyz",
        createdFromBranch: "main",
        commitAndPushWorkBranch,
      });
      const completeStepExecution = vi.fn(() => Promise.resolve(undefined));

      await writeCurrentExecutionInfoFile(workspacePath, {
        stepExecutionId: startedExecution.stepExecutionId,
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          additionalProperties: false,
          properties: { summary: { type: "string" } },
        },
      });
      await writeFile(
        buildFindingsSubmissionPath(workspacePath),
        `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
        "utf8",
      );

      const result = await tryPersistAgentFindings(
        createDeps(completeStepExecution),
        startedExecution,
        {
          onBeforeComplete: async () => {
            await startedExecution.environment.commitAndPushWorkBranch?.();
          },
        },
      );

      expect(result).toBe("submitted");
      expect(completeStepExecution).toHaveBeenCalledTimes(1);
    },
  );
});
