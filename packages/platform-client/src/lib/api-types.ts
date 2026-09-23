/**
 * Local, correctly-nullable mirrors of the wire shapes this package reads
 * off `@boboddy/sdk`'s generated `BoboddyClient` responses.
 *
 * Why not import the generated response types (`GetApi...Responses[200]`)
 * directly from `@boboddy/sdk`: `@hey-api/openapi-ts` encodes every
 * nullable field as `T | unknown`, which TypeScript collapses to plain
 * `unknown` (`unknown` absorbs any union member) — e.g. the generated
 * `workBranch` field types as `unknown`, not `string | null`. That makes
 * the generated types unusable for the formatting logic in this package,
 * which needs real nullability to render "—" vs a value. These types
 * intentionally mirror the zod contracts in `packages/core` (which this
 * package does not depend on — see `packages/worker`'s package.json for
 * the same precedent of talking to the API purely through `@boboddy/sdk`
 * without a `@boboddy/core` dependency) rather than the generated ones.
 */

export type ApiErrorBody = {
  status: number;
  title?: string;
  detail?: string;
};

export type PipelineExecutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked"
  | "routed";

export type PipelineStepRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "satisfied"
  | "unsatisfied"
  | "blocked"
  | "cancelled"
  | "abandoned"
  | "timeout";

export type PipelineStepRunSatisfactionStatus =
  | "not_evaluated"
  | "satisfied_by_policy"
  | "satisfied_by_user"
  | "unsatisfied_by_policy"
  | "not_applicable";

export type PipelineStepEvaluation = {
  id: string;
  decisionKind:
    | "step_policy"
    | "choice"
    | "loop_until"
    | "advance_each"
    | "advance_all";
  finalStatus: "pass" | "fail";
  finalAction:
    | "continue"
    | "block"
    | "complete"
    | "route"
    | "route_to_node"
    | "repeat";
  finalPayloadJson: Record<string, unknown> | null;
  createdAt: string;
};

export type PipelineStepRun = {
  id: string;
  stepKey: string;
  position: number;
  nodeKind:
    | "step"
    | "fanOut"
    | "cohortGate"
    | "choice"
    | "parallel"
    | "loop"
    | "succeed"
    | "fail";
  branchIndex: number | null;
  status: PipelineStepRunStatus;
  satisfactionStatus: PipelineStepRunSatisfactionStatus;
  stepExecutionId: string | null;
  workBranch: string | null;
  outputJson: unknown;
  evaluation: PipelineStepEvaluation | null;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  acceptanceReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PipelineExecutionAttempt = {
  id: string;
  attemptNumber: number;
  currentStepKey: string | null;
  startedAt: string | null;
  completedAt: string | null;
  status: PipelineExecutionStatus;
  stepRuns: PipelineStepRun[];
};

export type PipelineExecution = {
  id: string;
  workItemId: string;
  workItemTitle: string;
  pipelineDefinitionId: string;
  definitionStepCount: number;
  status: PipelineExecutionStatus;
  attempts: PipelineExecutionAttempt[];
};

export type PipelineStepDefinition = {
  id: string;
  key: string;
  name: string;
  position: number;
};

export type PipelineDefinition = {
  id: string;
  key: string;
  name: string;
  stepDefinitions: PipelineStepDefinition[];
};

export type WorkItem = {
  id: string;
  title: string;
  url: string | null;
};

export type StepExecutionStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "abandoned"
  | "cancelled"
  | "skipped";

export type StepSignalType = "string" | "number" | "boolean" | "object" | "array";
export type StepSignalSource = "extracted" | "computed";

export type StepSignal = {
  id: string;
  key: string;
  type: StepSignalType;
  source: StepSignalSource;
  valueJson: unknown;
  sourcePath: string | null;
};

export type StepExecutionResult = {
  id: string;
  status: "succeeded" | "failed";
  resultJson: unknown;
  errorJson: unknown;
  signals: StepSignal[];
};

export type StepExecution = {
  id: string;
  status: StepExecutionStatus;
  startedAt: string | null;
  completedAt: string | null;
  result: StepExecutionResult | null;
};

export const stepExecutionLogStreamValues = [
  "worker",
  "ai-server",
  "conversation",
] as const;
export type StepExecutionLogStream =
  (typeof stepExecutionLogStreamValues)[number];

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogLine = {
  seq: number;
  stream: StepExecutionLogStream;
  ts: string;
  content: string;
  level: LogLevel;
};

export type ReadStepExecutionLogsResult = {
  lines: LogLine[];
  nextOffset: number;
  complete: boolean;
};

export type StepExecutionLogArchive = {
  url: string | null;
  sizeBytes: number;
};

export type ConversationRole = "user" | "assistant";
export type ConversationToolStatus =
  | "pending"
  | "running"
  | "completed"
  | "error";

export type ConversationEvent =
  | {
      kind: "message";
      id: string;
      role: ConversationRole;
      modelID?: string;
      createdMs: number;
    }
  | {
      kind: "text";
      messageId: string;
      partId: string;
      role: ConversationRole;
      text: string;
    }
  | { kind: "reasoning"; messageId: string; partId: string; text: string }
  | {
      kind: "tool";
      messageId: string;
      partId: string;
      callId: string;
      tool: string;
      status: ConversationToolStatus;
      title?: string;
      output?: string;
      error?: string;
    }
  | {
      kind: "step-finish";
      messageId: string;
      cost: number;
      tokens: { input: number; output: number; reasoning: number };
    }
  | { kind: "session-error"; message: string };

export type ArtifactKind = "generic" | "playwright-trace";

export type Artifact = {
  id: string;
  relativeStorePath: string;
  sizeBytes: number | null;
  contentType: string | null;
  kind: ArtifactKind;
};

export type ArtifactDownloadUrl = {
  url: string | null;
  sizeBytes: number;
  contentType: string | null;
  relativeStorePath: string;
};
