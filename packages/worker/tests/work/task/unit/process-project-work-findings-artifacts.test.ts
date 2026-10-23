/**
 * The worker's artifact checks on a submitted findings file: an agent step's
 * artifact fields must match `artifacts.json` and the stored files, and a
 * code step's returned `Artifact.path(...)` values must name accepted,
 * non-empty files inside the step-artifacts folder. A failure fails the step
 * the way a schema mismatch does.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { writeStepArtifactSubmissions } from "@boboddy/sdk/contracts/step-artifact-submissions";
import { captureRejection } from "../../../support/capture-rejection";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import type { AnyJsonValue } from "../../../../src/common/contracts/json";
import {
  buildFindingsSubmissionPath,
  tryPersistAgentFindings,
  writeCurrentExecutionInfoFile,
} from "../../../../src/work/task/application/process-project-work-findings";
import type {
  ProcessProjectWorkDeps,
  StartedClaimedTask,
} from "../../../../src/work/task/contracts/process-project-work-types";

const RESULT_SCHEMA = {
  type: "object",
  required: ["report", "reproVideo"],
  additionalProperties: false,
  properties: {
    report: { type: "string" },
    reproVideo: {
      anyOf: [
        { type: "string", "x-boboddy-artifact": { accept: [".webm", ".mp4"] } },
        { type: "null" },
      ],
    },
  },
};

const TASK_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");

function createStartedTask(
  workspacePath: string,
  mode: "agent" | "code",
): StartedClaimedTask {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    taskId: TASK_ID,
    claimToken: "claim-token",
    agentSessionId: mode === "agent" ? "agent-session-id" : null,
    environment: {
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agent:
        mode === "agent"
          ? {
              baseUrl: "http://localhost:4096",
              password: "test-password",
              version: "0.0.0-test",
              logDirectory: path.join(workspacePath, ".logs"),
            }
          : null,
      aiImage: "boboddy/ai-worker:local",
      networkName: "test-network",
      secretValues: [],
      cleanup: () => Promise.resolve(),
    },
  };
}

function createDeps(
  completeTask: ProcessProjectWorkDeps["workerClient"]["completeTask"],
): ProcessProjectWorkDeps {
  return {
    workerClient: {
      userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
      claimTasks: vi.fn(),
      heartbeatTask: vi.fn(),
      failTask: vi.fn(),
      completeTask,
      appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
      getTask: vi.fn(),
      getTaskWorkerContext: vi.fn(),
      createArtifactUploadUrl: vi.fn(),
      recordArtifact: vi.fn(),
      recordArtifactFailure: vi.fn(),
    },
    createRunTracker: vi.fn(),
    runtimeEnvironmentOrchestrator: { launch: vi.fn() },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: vi.fn(),
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: { saveArtifact: vi.fn() },
    sleep: vi.fn(),
  };
}

async function setUpWorkspace(input: {
  findingsJson: AnyJsonValue;
  files?: Record<string, string>;
}): Promise<string> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "boboddy-findings-artifacts-"),
  );
  await writeCurrentExecutionInfoFile(workspacePath, {
    taskId: TASK_ID,
    resultSchemaJson: RESULT_SCHEMA,
  });
  await writeFile(
    buildFindingsSubmissionPath(workspacePath),
    `${JSON.stringify({ findingsJson: input.findingsJson })}\n`,
    "utf8",
  );
  for (const [name, content] of Object.entries(input.files ?? {})) {
    const filePath = path.join(workspacePath, ".boboddy/step-artifacts", name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return workspacePath;
}

async function persist(
  workspacePath: string,
  mode: "agent" | "code",
): Promise<{ completeTask: ReturnType<typeof vi.fn>; error: Error | null }> {
  const completeTask = vi.fn(() => Promise.resolve(undefined));
  try {
    await tryPersistAgentFindings(
      createDeps(completeTask),
      createStartedTask(workspacePath, mode),
    );
    return { completeTask, error: null };
  } catch (rejection) {
    return {
      completeTask,
      error:
        rejection instanceof Error ? rejection : new Error(String(rejection)),
    };
  }
}

const submitted = (stored: string) => ({
  stored,
  sourcePath: `/tmp/${stored}`,
  sizeBytes: 5,
});

describe("findings artifact checks — agent steps", () => {
  test.concurrent(
    "completes when the artifact field matches artifacts.json and the stored file exists",
    async () => {
      const workspacePath = await setUpWorkspace({
        findingsJson: { report: "r", reproVideo: "reproVideo.webm" },
        files: { "reproVideo.webm": "bytes" },
      });
      await writeStepArtifactSubmissions(workspacePath, {
        fields: { reproVideo: submitted("reproVideo.webm") },
        extra: [],
      });

      const { completeTask, error } = await persist(workspacePath, "agent");

      expect(error).toBeNull();
      expect(completeTask).toHaveBeenCalledTimes(1);
    },
  );

  test.concurrent(
    "fails a hand-written findings file whose artifact field was never submitted",
    async () => {
      const workspacePath = await setUpWorkspace({
        findingsJson: { report: "r", reproVideo: "reproVideo.webm" },
        files: { "reproVideo.webm": "bytes" },
      });

      const { completeTask, error } = await persist(workspacePath, "agent");

      expect(error?.message).toBe(
        '`reproVideo` is "reproVideo.webm" in the findings, but the submitted artifacts record null.',
      );
      expect(completeTask).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "fails when the submitted file is gone, alongside any schema mismatch",
    async () => {
      const workspacePath = await setUpWorkspace({
        findingsJson: { report: 7, reproVideo: "reproVideo.webm" },
      });
      await writeStepArtifactSubmissions(workspacePath, {
        fields: { reproVideo: submitted("reproVideo.webm") },
        extra: [],
      });

      const { completeTask, error } = await persist(workspacePath, "agent");

      expect(error?.message.split("\n")).toEqual([
        "findingsJson does not match resultSchemaJson: /report must be string",
        '`reproVideo` was submitted as reproVideo.webm, but .boboddy/step-artifacts/reproVideo.webm is missing or empty. Save the file again and call `boboddy-submit-artifact` with `field: "reproVideo"`.',
      ]);
      expect(completeTask).not.toHaveBeenCalled();
    },
  );
});

describe("findings artifact checks — code steps", () => {
  test.concurrent(
    "completes when the returned path names an accepted, non-empty file",
    async () => {
      const workspacePath = await setUpWorkspace({
        findingsJson: { report: "r", reproVideo: "runs/clip.mp4" },
        files: { "runs/clip.mp4": "bytes" },
      });

      const { completeTask, error } = await persist(workspacePath, "code");

      expect(error).toBeNull();
      expect(completeTask).toHaveBeenCalledTimes(1);
    },
  );

  test.concurrent("accepts a null artifact field", async () => {
    const workspacePath = await setUpWorkspace({
      findingsJson: { report: "r", reproVideo: null },
    });

    const { error } = await persist(workspacePath, "code");

    expect(error).toBeNull();
  });

  test.concurrent(
    "rejects a returned path that leaves the artifacts folder",
    async () => {
      const workspacePath = await setUpWorkspace({
        findingsJson: { report: "r", reproVideo: "../secrets.webm" },
      });

      const failure = await captureRejection(
        tryPersistAgentFindings(
          createDeps(vi.fn(() => Promise.resolve(undefined))),
          createStartedTask(workspacePath, "code"),
        ),
      );

      expect(failure.message).toBe(
        '`reproVideo` must be a path relative to .boboddy/step-artifacts (use `Artifact.path("<name>")`), got "../secrets.webm".',
      );
    },
  );

  test.concurrent("rejects a missing or empty file", async () => {
    const workspacePath = await setUpWorkspace({
      findingsJson: { report: "r", reproVideo: "clip.webm" },
      files: { "clip.webm": "" },
    });

    const { error } = await persist(workspacePath, "code");

    expect(error?.message).toBe(
      "`reproVideo` is clip.webm, but .boboddy/step-artifacts/clip.webm is missing or empty.",
    );
  });

  test.concurrent(
    "rejects an extension the field does not accept",
    async () => {
      const workspacePath = await setUpWorkspace({
        findingsJson: { report: "r", reproVideo: "clip.mkv" },
        files: { "clip.mkv": "bytes" },
      });

      const { error } = await persist(workspacePath, "code");

      expect(error?.message).toBe(
        "`reproVideo` accepts .webm, .mp4, but clip.mkv has .mkv.",
      );
    },
  );
});
