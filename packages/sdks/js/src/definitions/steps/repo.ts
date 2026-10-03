import {
  repoConfigInputSchema,
  repoRuntimeMismatch,
  type RepoConfigInput,
  type RepoExecutionMode,
} from "../../repo-config";
import {
  createPromptInputProxy,
  type PromptInputProxy,
} from "./prompt-template";
import type { RuntimeSpec } from "./runtime";

/**
 * Authoring helpers for a step's `environment.repo` option, and the
 * definition-time compilation that turns it into the `repo` wire field
 * (`../../repo-config.ts`).
 */

/** The step gets no repository: no clone, branch, commit or push. */
export type NoneRepoSpec = { readonly mode: "none" };

/** Clones and checks out the base branch; creates no branch, commits and pushes nothing. */
export type ReadOnlyRepoSpec = { readonly mode: "readOnly" };

export type ReadWriteRepoSpec = {
  readonly mode: "readWrite";
  /**
   * Commit message template; `{{input.…}}` and `{{result.…}}` tokens only, one
   * line, at most 500 characters. Defaults to `boboddy: step <stepExecutionId>`.
   */
  readonly message?: string;
  /** Defaults to `"fail"`: a failed push fails the step. */
  readonly onPushFailure?: "fail" | "warn";
};

export type RepoSpec = NoneRepoSpec | ReadOnlyRepoSpec | ReadWriteRepoSpec;

/** What `Runtime.devcontainer()` accepts. */
export type DevcontainerRepoSpec = ReadOnlyRepoSpec | ReadWriteRepoSpec;

/** What `Runtime.host()` accepts. */
export type HostRepoSpec = NoneRepoSpec;

/** Runs once at definition time, against the same proxies `agentPrompt` and `vars` use. */
export type RepoFn<TInput, TResult, TSpec extends RepoSpec> = (context: {
  input: PromptInputProxy<TInput>;
  result: PromptInputProxy<TResult>;
}) => TSpec;

export type RepoField<TInput, TResult, TSpec extends RepoSpec> =
  TSpec | RepoFn<TInput, TResult, TSpec>;

export type ReadWriteRepoOpts = Omit<ReadWriteRepoSpec, "mode">;

export const Repo = {
  /**
   * The step gets no repository. What `Runtime.host()` already implies, stated
   * as a value. Only valid with `Runtime.host()`.
   */
  none(): NoneRepoSpec {
    return { mode: "none" };
  },

  /**
   * Clones and checks out the base branch, but creates no work branch, commits
   * nothing, pushes nothing and reports no `workBranch`. A policy, not a
   * sandbox: edits the agent makes stay in the workspace and are discarded.
   */
  readOnly(): ReadOnlyRepoSpec {
    return { mode: "readOnly" };
  },

  /**
   * Creates a work branch, then commits and pushes it when the step succeeds.
   * This is the default for a devcontainer step.
   */
  readWrite(opts?: ReadWriteRepoOpts): ReadWriteRepoSpec {
    return { mode: "readWrite", ...opts };
  },
} as const;

export type CompileRepoContext = {
  /** Named in error messages. */
  readonly stepKey?: string;
};

function executionModeOf(runtime: RuntimeSpec | undefined): RepoExecutionMode {
  return runtime?.kind === "host" ? "no_workspace" : "workspace";
}

/**
 * Runs the authored `environment.repo` once (the function form against `input`
 * and `result` proxies) and returns the wire shape, or `undefined` when the step
 * declares no `repo`. Throws when the mode does not fit the runtime or breaks
 * the `repoConfigInputSchema` rules.
 */
export function compileRepo<TInput, TResult>(
  repo: RepoField<TInput, TResult, RepoSpec> | undefined,
  runtime: RuntimeSpec | undefined,
  ctx: CompileRepoContext = {},
): RepoConfigInput | undefined {
  if (repo === undefined) return undefined;

  const spec =
    typeof repo === "function"
      ? repo({
          input: createPromptInputProxy<TInput>(["input"]),
          result: createPromptInputProxy<TResult>(["result"]),
        })
      : repo;

  const where = ctx.stepKey ? `Step "${ctx.stepKey}" repo` : "repo";
  const executionMode = executionModeOf(runtime);
  const mismatch = repoRuntimeMismatch(executionMode, spec.mode);
  if (mismatch !== null) {
    throw new Error(
      `${where} "${spec.mode}" cannot be used with executionMode "${executionMode}": ${mismatch}.`,
    );
  }

  const config: RepoConfigInput =
    spec.mode === "readWrite" ? toReadWriteConfig(spec) : { mode: spec.mode };
  const parsed = repoConfigInputSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `${where}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "mode"} ${issue.message}`).join("; ")}`,
    );
  }
  return config;
}

function toReadWriteConfig(spec: ReadWriteRepoSpec): RepoConfigInput {
  return {
    mode: "readWrite",
    ...(spec.message !== undefined
      ? {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-template-expression -- a bare input or result reference is a proxy object typed as string; the template coerces it to its {{…}} token
          message: `${spec.message}`,
        }
      : {}),
    ...(spec.onPushFailure !== undefined
      ? { onPushFailure: spec.onPushFailure }
      : {}),
  };
}
