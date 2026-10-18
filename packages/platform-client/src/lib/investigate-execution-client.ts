import type {
  ApiErrorBody,
  Artifact,
  ArtifactDownloadUrl,
  PipelineDefinition,
  PipelineExecution,
  ReadTaskLogsResult,
  Task,
  TaskLogArchive,
  TaskLogStream,
  WorkItem,
} from "./api-types";

/** Every call this package makes returns this shape (mirrors `@boboddy/sdk`'s
 * generated `RequestResult`'s non-`throwOnError` branch: `data`/`error` are
 * mutually exclusive, discriminated on which is `undefined`). */
type ApiResult<TData> =
  { data: TData; error: undefined } | { data: undefined; error: ApiErrorBody };

export type AuthHeaders = { Authorization: string };

/**
 * Saves a step's full, uncapped rendered log to some caller-owned location
 * (the `platform-client` package stays side-effect-free; only `apps/cli`
 * supplies a real, disk-touching implementation). Resolves to the path
 * written, which goes on the log header line; a rejection's message is shown
 * there instead.
 */
export type FullLogSaver = (input: {
  taskId: string;
  requestedStream: TaskLogStream | "all";
  fullText: string;
}) => Promise<string>;

/**
 * The minimal slice of `ReturnType<typeof createBoboddyClient>`
 * (`@boboddy/sdk/client`) that {@link investigateExecution} calls, rather than
 * the full generated `BoboddyClient` type; tests construct a lightweight fake
 * instead of standing up a full generated client. Method/param names verified
 * against `packages/sdks/js/src/generated/sdk.gen.ts`.
 *
 * A real `BoboddyClient` matches this interface at runtime, but NOT
 * structurally as far as TypeScript is concerned: `@hey-api/openapi-ts`
 * encodes every nullable field on the generated response types as `T |
 * unknown`, which collapses to plain `unknown` (the same quirk `./api-types.ts`
 * documents as the reason this package defines its own nullable-correct
 * mirror types). That makes the generated client's real return types
 * structurally incompatible with this interface's, so a caller passing a real
 * `BoboddyClient` (e.g. `apps/cli`'s `execution view` command) needs an
 * `as unknown as InvestigateExecutionClient` cast at the call site — see
 * `apps/cli/src/commands/execution.ts` for the documented cast.
 */
export type InvestigateExecutionClient = {
  pipelineExecutions: {
    getPipelineExecution: (options: {
      path: { pipelineExecutionId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<PipelineExecution>>;
  };
  pipelineDefinitions: {
    getPipelineDefinition: (options: {
      path: { pipelineDefinitionId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<PipelineDefinition>>;
  };
  workItems: {
    getWorkItem: (options: {
      path: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItem>>;
  };
  tasks: {
    getTask: (options: {
      path: { taskId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<Task>>;
    readTaskLogs: (options: {
      path: { taskId: string };
      query: { from: number; limit: number };
      headers: AuthHeaders;
    }) => Promise<ApiResult<ReadTaskLogsResult>>;
    getTaskLogArchive: (options: {
      path: { taskId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<TaskLogArchive>>;
    listTaskArtifacts: (options: {
      path: { taskId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<Artifact[]>>;
    getArtifactDownloadUrl: (options: {
      path: { taskId: string; artifactId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<ArtifactDownloadUrl>>;
  };
};
