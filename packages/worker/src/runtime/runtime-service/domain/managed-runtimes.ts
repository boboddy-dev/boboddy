import {
  isManagedRuntimeId,
  MANAGED_RUNTIME_IDS,
  type ManagedRuntimeId,
} from "@boboddy/sdk/managed-runtimes";
import { PIPELINE_BUILDER_DIR } from "@boboddy/sdk/push";

/**
 * Worker-side registry of managed runtimes: the containers a `codeStep` can run
 * in instead of the project's devcontainer. The SDK owns the identifier list;
 * this registry owns what each identifier means (image, user, runtime binary),
 * so an identifier the SDK adds without a worker entry fails type-check here.
 *
 * One runtime per image: the runner invokes `runtime` directly and never sniffs
 * `PATH`.
 */
export type ManagedRuntimeDefinition = {
  /** The JS runtime the image provides and the code-step runner invokes. */
  runtime: "bun" | "node";
  image: string;
  remoteUser: string;
};

export const MANAGED_RUNTIMES = {
  bun1: {
    runtime: "bun",
    image: "oven/bun:1.4.0-debian",
    remoteUser: "bun",
  },
  node24: {
    runtime: "node",
    image: "node:24-bookworm-slim",
    remoteUser: "node",
  },
} satisfies Record<ManagedRuntimeId, ManagedRuntimeDefinition>;

export type ResolvedManagedRuntime = {
  id: ManagedRuntimeId;
  definition: ManagedRuntimeDefinition;
};

/**
 * Raised when a step names a managed runtime this worker does not know: the
 * server (or SDK) is newer than the worker. Fails the step before launch.
 */
export class UnknownManagedRuntimeError extends Error {
  readonly managedRuntime: string;

  constructor(managedRuntime: string) {
    super(
      `Managed runtime "${managedRuntime}" is not supported by this worker. ` +
        `Supported managed runtimes: ${MANAGED_RUNTIME_IDS.join(", ")}. ` +
        "Upgrade the Boboddy CLI to a version that supports it.",
    );
    this.name = "UnknownManagedRuntimeError";
    this.managedRuntime = managedRuntime;
  }
}

export function resolveManagedRuntime(id: string): ResolvedManagedRuntime {
  if (!isManagedRuntimeId(id)) {
    throw new UnknownManagedRuntimeError(id);
  }
  return { id, definition: MANAGED_RUNTIMES[id] };
}

/**
 * Repo-relative directory the synthesized managed devcontainer configs are
 * written under, as `<dir>/<id>/devcontainer.json`. Distinct from the
 * host-side `~/.boboddy/runtimes/` OpenCode payload cache: it holds configs
 * that reference an image by tag, and it is never committed.
 */
export const MANAGED_DEVCONTAINERS_DIR = ".boboddy/managed-devcontainers";

/**
 * Paths a managed install can leave in the clone, relative to the repo root:
 * the dependency tree and the lockfiles the package manager may generate. Kept
 * out of work-branch commits for repos that do not gitignore them.
 */
export const MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS = [
  `${PIPELINE_BUILDER_DIR}/node_modules`,
  `${PIPELINE_BUILDER_DIR}/bun.lock`,
  `${PIPELINE_BUILDER_DIR}/package-lock.json`,
] as const;
