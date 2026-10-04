/**
 * The worker's managed runtime registry against the SDK's identifier list, and
 * the failure for an identifier this worker does not know.
 */
import { describe, expect, test } from "bun:test";
import { MANAGED_RUNTIME_IDS } from "@boboddy/sdk/managed-runtimes";
import {
  MANAGED_RUNTIMES,
  resolveManagedRuntime,
  UnknownManagedRuntimeError,
} from "../../../../src/runtime/runtime-service/domain/managed-runtimes";

describe("MANAGED_RUNTIMES", () => {
  test("has exactly one entry per SDK identifier", () => {
    expect(Object.keys(MANAGED_RUNTIMES).sort()).toEqual(
      [...MANAGED_RUNTIME_IDS].sort(),
    );
  });

  test("pins the v1 images, users and runtimes", () => {
    expect(MANAGED_RUNTIMES).toEqual({
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
    });
  });
});

describe("resolveManagedRuntime", () => {
  test.each([...MANAGED_RUNTIME_IDS])("resolves %s to its definition", (id) => {
    expect(resolveManagedRuntime(id)).toEqual({
      id,
      definition: MANAGED_RUNTIMES[id],
    });
  });

  test("an unknown identifier fails naming it, the supported ones and the upgrade", () => {
    let caught: unknown;
    try {
      resolveManagedRuntime("bun2");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownManagedRuntimeError);
    expect((caught as UnknownManagedRuntimeError).managedRuntime).toBe("bun2");
    expect((caught as Error).message).toBe(
      'Managed runtime "bun2" is not supported by this worker. ' +
        "Supported managed runtimes: bun1, node24. " +
        "Upgrade the Boboddy CLI to a version that supports it.",
    );
  });
});
