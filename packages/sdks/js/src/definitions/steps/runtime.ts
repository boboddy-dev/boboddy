import type { EnvVarsInput } from "../../env-vars";
import { devcontainerConfigPathSchema } from "../../devcontainer-config-path";
import {
  MANAGED_RUNTIME_IDS,
  type ManagedRuntimeId,
} from "../../managed-runtimes";
import type { RepoConfigInput } from "../../repo-config";
import { normalizeEnv, type EnvFn, type EnvRecord } from "./env";
import {
  compileRepo,
  type CompileRepoContext,
  type DevcontainerRepoSpec,
  type HostRepoSpec,
  type RepoField,
} from "./repo";

/**
 * Authoring helpers for a step's `environment` option, and the definition-time
 * compilation that turns it into the wire fields `executionMode`,
 * `managedRuntime`, `devcontainerConfigPath`, `envJson` and `repo`.
 */

/** Where a step runs. Build one with `Runtime.devcontainer()`, `Runtime.host()` or `Runtime.managed.<id>()`. */
export type DevcontainerRuntimeSpec = {
  readonly kind: "devcontainer";
  readonly config?: string;
};

export type HostRuntimeSpec = { readonly kind: "host" };

/**
 * A worker-supplied container (image, config and dependency install owned by
 * the worker). Build one with `Runtime.managed.<id>()`. `codeStep` only.
 */
export type ManagedRuntimeSpec<
  TId extends ManagedRuntimeId = ManagedRuntimeId,
> = {
  readonly kind: "managed";
  readonly id: TId;
};

export type RuntimeSpec =
  DevcontainerRuntimeSpec | HostRuntimeSpec | ManagedRuntimeSpec;

/**
 * How a step runs: its `runtime`, its environment `vars` and its `repo` access.
 * A union on the runtime kind, so a `repo` the runtime cannot honor is a type
 * error: a host step takes only `Repo.none()`, a devcontainer step takes
 * `Repo.readOnly()` or `Repo.readWrite()`.
 *
 * Declare `vars` before `agentPrompt` so `TEnv` is inferred into the prompt's
 * `env`, which is then strict: only declared, non-secret keys.
 */
export type StepEnvironment<
  TInput,
  TEnv extends EnvRecord = EnvRecord,
  TResult = unknown,
> =
  | {
      /** Defaults to `Runtime.devcontainer()`. */
      runtime?: DevcontainerRuntimeSpec;
      vars?: EnvFn<TInput, TEnv>;
      /** Defaults to `Repo.readWrite()`. */
      repo?: RepoField<TInput, TResult, DevcontainerRepoSpec>;
    }
  | {
      runtime: HostRuntimeSpec;
      vars?: EnvFn<TInput, TEnv>;
      /** Defaults to `Repo.none()`. */
      repo?: RepoField<TInput, TResult, HostRepoSpec>;
    };

/**
 * `codeStep`'s environment: `StepEnvironment`'s devcontainer variant plus
 * managed runtimes. A code step runs repo code, which needs a clone, and the
 * host runtime has none.
 */
export type CodeStepEnvironment<TInput, TResult = unknown> = {
  /**
   * Defaults to `Runtime.managed.bun1()`. `Runtime.devcontainer()` opts into the
   * project's own container. `Runtime.host()` is not supported.
   */
  runtime?: DevcontainerRuntimeSpec | ManagedRuntimeSpec;
  vars?: EnvFn<TInput>;
  /** Defaults to `Repo.readWrite()`. */
  repo?: RepoField<TInput, TResult, DevcontainerRepoSpec>;
};

export type DevcontainerRuntimeOpts = {
  /**
   * Full repo-relative path to the devcontainer config, e.g.
   * `.devcontainer/frontend/devcontainer.json`. The basename must be
   * `devcontainer.json` or `.devcontainer.json`. There is no fallback: if the
   * file is missing on the step's base branch, the step fails.
   */
  readonly config?: string;
};

export type ManagedRuntimeFactories = {
  readonly [K in ManagedRuntimeId]: () => ManagedRuntimeSpec<K>;
};

const managedRuntimeFactories = Object.fromEntries(
  MANAGED_RUNTIME_IDS.map((id) => [id, () => ({ kind: "managed", id })]),
) as ManagedRuntimeFactories;

export const Runtime = {
  /**
   * Worker-supplied containers for `codeStep`, one factory per identifier, for
   * example `Runtime.managed.bun1()`. The worker owns the image and installs the
   * pipeline-builder dependencies; the repo holds nothing. An unknown identifier
   * is a type error. Not supported for `defineStep`.
   */
  managed: managedRuntimeFactories,

  /**
   * Runs the step in the repository's devcontainer. Without `config` the worker
   * searches for `.devcontainer/devcontainer.json`, then `devcontainer.json`.
   * Throws when `config` breaks the path rules.
   */
  devcontainer(opts?: DevcontainerRuntimeOpts): DevcontainerRuntimeSpec {
    if (opts?.config === undefined) return { kind: "devcontainer" };
    const parsed = devcontainerConfigPathSchema.safeParse(opts.config);
    if (!parsed.success) {
      throw new Error(
        `Runtime.devcontainer config "${opts.config}": ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    return { kind: "devcontainer", config: parsed.data };
  },

  /**
   * Runs the step on the worker host, with no clone and no container. Takes no
   * options, so a config path cannot be combined with it. Not supported for
   * `codeStep`, which needs a workspace.
   */
  host(): HostRuntimeSpec {
    return { kind: "host" };
  },
} as const;

export type CompiledEnvironment = {
  executionMode: "workspace" | "no_workspace";
  devcontainerConfigPath: string | null;
  managedRuntime: ManagedRuntimeId | null;
  envJson: EnvVarsInput | null;
  /** `undefined` when the author wrote no `repo`; the server resolves the default. */
  repo: RepoConfigInput | undefined;
};

export type CompileEnvironmentContext = CompileRepoContext & {
  /** Used when the environment declares no `runtime`. `codeStep` passes the default managed runtime. */
  readonly defaultRuntime?: ManagedRuntimeSpec;
};

/**
 * Turns the authored `environment` into its wire fields. Runs `vars` and `repo`
 * once. Throws on a static secret, or a static literal on a secret-looking name,
 * and on a `repo` the runtime cannot honor or that breaks the commit message
 * rules.
 */
export function compileEnvironment<TInput, TEnv extends EnvRecord, TResult>(
  environment:
    | StepEnvironment<TInput, TEnv, TResult>
    | CodeStepEnvironment<TInput, TResult>
    | undefined,
  ctx: CompileEnvironmentContext = {},
): CompiledEnvironment {
  const runtime: RuntimeSpec | undefined =
    environment?.runtime ?? ctx.defaultRuntime;
  return {
    executionMode: runtime?.kind === "host" ? "no_workspace" : "workspace",
    devcontainerConfigPath:
      runtime?.kind === "devcontainer" ? (runtime.config ?? null) : null,
    managedRuntime: runtime?.kind === "managed" ? runtime.id : null,
    envJson: normalizeEnv(environment?.vars),
    repo: compileRepo(environment?.repo, runtime, ctx),
  };
}
