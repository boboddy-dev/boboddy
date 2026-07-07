import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { OpenCodePlugins } from "../../../common/contracts/opencode-plugin";

export type StepExecutionStatus =
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
  requestedBranch: string | null;
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
      healthcheck: {
        protocol: "tcp" | "http";
        path: string | null;
        expectedStatus: number | null;
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
    prompt: string;
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
  };
  agentPrompt: {
    sessionTitle: string;
    promptText: string;
    stepInstructionsPlaceholder: string;
  };
};
