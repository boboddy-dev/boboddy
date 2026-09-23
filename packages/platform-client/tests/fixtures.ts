import type {
  Artifact,
  ArtifactDownloadUrl,
  PipelineDefinition,
  PipelineExecution,
  PipelineExecutionAttempt,
  PipelineStepDefinition,
  PipelineStepRun,
  StepExecution,
  WorkItem,
} from "../src/lib/api-types";

export function makeStepDefinition(
  overrides: Partial<PipelineStepDefinition> = {},
): PipelineStepDefinition {
  return {
    id: "step-def-1",
    key: "investigate",
    name: "Investigate",
    position: 1,
    ...overrides,
  };
}

export function makeStepRun(
  overrides: Partial<PipelineStepRun> = {},
): PipelineStepRun {
  return {
    id: "step-run-1",
    stepKey: "investigate",
    position: 1,
    nodeKind: "step",
    branchIndex: null,
    status: "satisfied",
    satisfactionStatus: "satisfied_by_policy",
    stepExecutionId: "step-exec-1",
    workBranch: "boboddy/investigate-1",
    outputJson: { summary: "looked good" },
    evaluation: null,
    acceptedByUserId: null,
    acceptedAt: null,
    acceptanceReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
}

export function makeAttempt(
  overrides: Partial<PipelineExecutionAttempt> = {},
): PipelineExecutionAttempt {
  return {
    id: "attempt-1",
    attemptNumber: 1,
    currentStepKey: "investigate",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    status: "running",
    stepRuns: [makeStepRun()],
    ...overrides,
  };
}

export function makeExecution(
  overrides: Partial<PipelineExecution> = {},
): PipelineExecution {
  return {
    id: "01a0b53a-e335-735b-9600-ded80d3488d2",
    workItemId: "01a0b53a-d8ad-7656-84a9-a0a1403bcc0e",
    workItemTitle: "Fix the flaky test",
    pipelineDefinitionId: "pipeline-def-1",
    definitionStepCount: 1,
    status: "running",
    attempts: [makeAttempt()],
    ...overrides,
  };
}

export function makePipelineDefinition(
  overrides: Partial<PipelineDefinition> = {},
): PipelineDefinition {
  return {
    id: "pipeline-def-1",
    key: "bug-triage",
    name: "Bug Triage",
    stepDefinitions: [makeStepDefinition()],
    ...overrides,
  };
}

export function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "01a0b53a-d8ad-7656-84a9-a0a1403bcc0e",
    title: "Fix the flaky test",
    url: "https://github.com/example/repo/issues/42",
    ...overrides,
  };
}

export function makeStepExecution(
  overrides: Partial<StepExecution> = {},
): StepExecution {
  return {
    id: "step-exec-1",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:05.000Z",
    completedAt: "2026-01-01T00:04:55.000Z",
    result: {
      id: "result-1",
      status: "succeeded",
      resultJson: { ok: true },
      errorJson: null,
      signals: [],
    },
    ...overrides,
  };
}

export function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    relativeStorePath: "trace.zip",
    sizeBytes: 1_024,
    contentType: "application/zip",
    kind: "generic",
    ...overrides,
  };
}

export function makeArtifactDownloadUrl(
  overrides: Partial<ArtifactDownloadUrl> = {},
): ArtifactDownloadUrl {
  return {
    url: "https://storage.example.test/trace.zip?sig=abc",
    sizeBytes: 1_024,
    contentType: "application/zip",
    relativeStorePath: "trace.zip",
    ...overrides,
  };
}
