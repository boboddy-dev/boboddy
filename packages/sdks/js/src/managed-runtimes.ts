import { z } from "zod";

/**
 * Registry of managed runtimes: worker-supplied containers a `codeStep` can run
 * in instead of the project's devcontainer (`Runtime.managed.<id>()`). The
 * identifier is the runtime family plus its major line. Image, distro and patch
 * version are worker registry details and never appear here.
 *
 * This module is the single owner of the identifier list: the SDK, core and the
 * worker all import from it. Adding an identifier is one entry here and one
 * worker registry entry.
 */

export const MANAGED_RUNTIME_IDS = ["bun1", "node24"] as const;

export type ManagedRuntimeId = (typeof MANAGED_RUNTIME_IDS)[number];

/** The runtime a `codeStep` gets when it declares none. */
export const DEFAULT_CODE_STEP_RUNTIME_ID = "bun1" satisfies ManagedRuntimeId;

export const managedRuntimeIdSchema = z.enum(MANAGED_RUNTIME_IDS);

export function isManagedRuntimeId(value: string): value is ManagedRuntimeId {
  return (MANAGED_RUNTIME_IDS as readonly string[]).includes(value);
}
