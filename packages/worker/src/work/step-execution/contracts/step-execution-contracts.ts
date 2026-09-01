import type { HealthCheck } from "@boboddy/sdk/health-checks";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { OpenCodePlugins } from "../../../common/contracts/opencode-plugin";

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

export type StepExecutionContract = {
  id: string;
  status: StepExecutionStatus;
};

export type StepExecutionWorkerContextContract = {
  projectId: string;
  gitUrl: string;
  /**
   * The previous step's work branch that this (later) step must be created off
   * of, handed down by the server. Null for the first step, which is created
   * off the repo-local configured base branch or the cloned default.
   */
  baseWorkBranch?: string | null;
  projectOpencodeConfig: {
    relativePath: string;
    present: boolean;
    commands: Array<{
      name: string;
      description: string;
      run: string;
      cwd: string | null;
    }>;
    services: Array<{
      name: string;
      description: string;
      run: string;
      cwd: string | null;
      dependsOn: Array<string>;
      expose: {
        targetPort: number;
        protocol: "tcp" | "http";
      };
    }>;
  };
  stepExecution: {
    id: string;
    status: StepExecutionStatus;
    inputJson: unknown;
    executionTimeoutSeconds: number | null;
  };
  stepDefinition: {
    id: string;
    key: string;
    name: string;
    /**
     * Null only for `kind === "code"` steps, which do real work via a plain
     * function instead of an LLM prompt (see `entrypointJson` below).
     */
    prompt: string | null;
    /**
     * `code` steps are plain functions instead of LLM prompts: the worker
     * skips prompt rendering/health-check-harness/`promptAsync` entirely and
     * instead resolves + imports `entrypointJson` against the target repo's
     * checkout (see `execute-code-step.ts`).
     */
    kind: "built_in" | "user_defined" | "code";
    /** `kind === "code"` only. A portable `{sourceFile, exportName}` pair. */
    entrypointJson: { sourceFile: string; exportName: string } | null;
    /**
     * How the step runs. `workspace` (default) clones the repo and launches a
     * devcontainer with OpenCode inside it; `no_workspace` runs OpenCode
     * directly on the host with only the rendered prompt + context, no clone
     * and no container. Surfaced by the API (Phase 3).
     */
    executionMode: "workspace" | "no_workspace";
    resultSchemaJson: Record<string, unknown> | null;
    opencodeMcpJson: OpenCodeMcpServers | null;
    opencodePluginJson: OpenCodePlugins | null;
    /**
     * The step's declared health checks (see `defineStep`'s `healthChecks`
     * field). `null`/empty means the step declares none — real step execution
     * then skips the health-check gate entirely (#120): no fake-AI harness
     * starts, no synthetic provider is registered, launch is unchanged.
     */
    healthChecksJson: HealthCheck[] | null;
  };
  agentPrompt: {
    sessionTitle: string;
    promptText: string;
    stepInstructionsPlaceholder: string;
  };
};
