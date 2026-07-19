import path from "node:path";

/**
 * Relative location (under the resolved workspace folder) where step artifacts
 * are written inside the runtime container. The absolute path is derived from
 * the runtime environment's `workspaceFolder` at runtime rather than hardcoding
 * `/workspace`.
 */
const STEP_ARTIFACTS_RELATIVE_DIR = ".boboddy/step-artifacts";

/**
 * Build the absolute, POSIX-style step-artifacts directory the agent sees
 * inside the runtime container, anchored at the resolved workspace folder.
 */
export function buildContainerStepArtifactsDir(workspaceFolder: string): string {
  return path.posix.join(workspaceFolder, STEP_ARTIFACTS_RELATIVE_DIR);
}

export function buildPromptRenderContext(input: {
  inputJson: unknown;
  env: NodeJS.ProcessEnv;
  artifactsDir: string;
}): Record<string, unknown> {
  const rootInput =
    input.inputJson &&
    typeof input.inputJson === "object" &&
    !Array.isArray(input.inputJson)
      ? input.inputJson
      : {};

  const definedEnv = Object.fromEntries(
    Object.entries(input.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  return {
    ...rootInput,
    input: input.inputJson,
    env: definedEnv,
    boboddy: {
      artifactsDir: input.artifactsDir,
    },
    // Preserve legacy prompt tokens while scoped names are adopted.
    stepArtifactsDir: input.artifactsDir,
  };
}

/**
 * Resolve the upstream base branch the repo is cloned at: the explicit context
 * value, else the `BOBODDY_WORK_REQUESTED_BRANCH` env override, else the repo
 * default (null).
 */
export function resolveRequestedBranch(
  requestedBranch: string | null | undefined,
): string | null {
  const explicitBranch = requestedBranch?.trim();
  if (explicitBranch) return explicitBranch;

  const envBranch = process.env["BOBODDY_WORK_REQUESTED_BRANCH"]?.trim();

  return envBranch || null;
}

/**
 * The previous step's work branch this step must be created off of. DISTINCT
 * from {@link resolveRequestedBranch}: `requestedBranch` is the upstream base the
 * repo is cloned at, `baseWorkBranch` is a prior `boboddy/...` branch. The
 * server populates the context field in Phase 2; for now it may be null.
 */
export function resolveBaseWorkBranch(
  baseWorkBranch: string | null | undefined,
): string | null {
  return baseWorkBranch?.trim() || null;
}

export function buildRunningMetadata(environment: {
  resolvedBranch: string;
  devcontainerConfigPath: string;
  aiImage: string;
  networkName: string;
}): string {
  return JSON.stringify({
    resolvedBranch: environment.resolvedBranch,
    devcontainerConfigPath: environment.devcontainerConfigPath,
    aiImage: environment.aiImage,
    networkName: environment.networkName,
  });
}
