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

/** Env var (in `.boboddy/.env`) that overrides the configured base branch. */
export const BASE_WORK_BRANCH_ENV_VAR = "BOBODDY_BASE_WORK_BRANCH";

/**
 * Resolve the base branch the FIRST step's work branch is created off of, from
 * repo-local configuration. Precedence: the `BOBODDY_BASE_WORK_BRANCH` env var
 * (from `.boboddy/.env`) over the `.boboddy/boboddy.jsonc` `baseWorkBranch`
 * field. Returns null when neither is set, in which case the step is created
 * off the repo's cloned default branch.
 *
 * DISTINCT from {@link resolveBaseWorkBranch}, which passes through the branch
 * the server hands down for later steps (the predecessor's work branch).
 */
export function resolveConfiguredBaseWorkBranch(input: {
  localEnvVars: Record<string, string>;
  configuredBaseWorkBranch: string | null | undefined;
}): string | null {
  const envBranch = input.localEnvVars[BASE_WORK_BRANCH_ENV_VAR]?.trim();
  if (envBranch) return envBranch;

  return input.configuredBaseWorkBranch?.trim() || null;
}

/**
 * The branch a step must be created off of, as handed down by the server (the
 * predecessor step's work branch). Later steps always chain off this; it takes
 * precedence over any repo-local configured base branch.
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
