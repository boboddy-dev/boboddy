import type { EnvVarSpec } from "@boboddy/sdk/env-vars";
import type { HealthCheck } from "@boboddy/sdk/health-checks";
import type { RepoConfig } from "@boboddy/sdk/repo-config";
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

/**
 * Mirrors the server's `stepDefinitionKindValues`. The worker does not depend
 * on `@boboddy/core`; `step-definition-kind-drift.test.ts` pins this union to
 * the SDK's generated API types so the two cannot drift.
 */
export type StepDefinitionKind = "built_in" | "user_defined" | "code";

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
    kind: StepDefinitionKind;
    /** `kind === "code"` only. The module holding the step, found there by `key`. */
    entrypointJson: { sourceFile: string } | null;
    /**
     * How the step runs. `workspace` (default) clones the repo and launches a
     * devcontainer with OpenCode inside it; `no_workspace` runs OpenCode
     * directly on the host with only the rendered prompt + context, no clone
     * and no container. Surfaced by the API (Phase 3).
     */
    executionMode: "workspace" | "no_workspace";
    /**
     * Repo-relative path of the devcontainer config this `workspace` step
     * launches (see `Runtime.devcontainer({ config })`). `null` auto-detects the
     * canonical config. Never set for `no_workspace` steps.
     */
    devcontainerConfigPath: string | null;
    /**
     * Identifier of the worker-supplied managed runtime this `code` step runs
     * in instead of a repo devcontainer (see `Runtime.managed`), or `null`.
     * Typed `string` rather than the SDK union because a server newer than
     * this worker can send an identifier it does not know; the launch then
     * fails naming it. Never set together with `devcontainerConfigPath`.
     */
    managedRuntime: string | null;
    /**
     * The step's resolved repository access (see `Repo` in the SDK). Never
     * null: the server resolves the runtime's default when a definition is
     * written. `no_workspace` steps are always `none`; `workspace` steps are
     * `readOnly` or `readWrite`.
     */
    repo: RepoConfig;
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
    /**
     * The step's declared environment variables (see `defineStep`'s `env`
     * field). `null` means none declared. Resolved once per run by
     * `resolveStepEnv` into the variables injected into the agent (or code
     * step) process.
     */
    envJson: EnvVarSpec[] | null;
  };
  agentPrompt: {
    sessionTitle: string;
    promptText: string;
    stepInstructionsPlaceholder: string;
  };
};
