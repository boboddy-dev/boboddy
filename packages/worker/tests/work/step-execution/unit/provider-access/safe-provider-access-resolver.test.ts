import { describe, expect, test } from "bun:test";
import { SafeProviderAccessResolver } from "../../../../../src/work/step-execution/infra/provider-access/safe-provider-access-resolver";
import type {
  ProviderAccess,
  ProviderAccessResolver,
  ResolveProviderAccessInput,
} from "../../../../../src/work/step-execution/contracts/agent-runtime/provider-access-resolver";
import { createUuidV7 } from "../../../../../src/common/contracts/uuid-v7";

function makeInput(): ResolveProviderAccessInput {
  return {
    projectId: createUuidV7(),
    sessionId: createUuidV7(),
    requestedByUserId: createUuidV7(),
  };
}

function resolverReturning(access: ProviderAccess): ProviderAccessResolver {
  return {
    resolve: () => Promise.resolve(access),
  };
}

function resolverThrowing(error: Error): ProviderAccessResolver {
  return {
    resolve: () => Promise.reject(error),
  };
}

describe("SafeProviderAccessResolver", () => {
  test("passes through a successful resolution and clears lastError", async () => {
    const inner = resolverReturning({ mode: "direct", tokenEnv: "MY_TOKEN" });
    const safe = new SafeProviderAccessResolver(inner);

    const access = await safe.resolve(makeInput());

    expect(access).toEqual({ mode: "direct", tokenEnv: "MY_TOKEN" });
    expect(safe.lastError).toBeNull();
  });

  test("returns an empty direct access and records the error on failure", async () => {
    const inner = resolverThrowing(new Error("no credential found"));
    const safe = new SafeProviderAccessResolver(inner);

    const access = await safe.resolve(makeInput());

    expect(access).toEqual({ mode: "direct" });
    expect(safe.lastError?.message).toBe("no credential found");
  });

  test("wraps a non-Error throw into an Error", async () => {
    const inner: ProviderAccessResolver = {
      // Intentionally reject with a non-Error to exercise the wrapping branch.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      resolve: () => Promise.reject("plain string failure"),
    };
    const safe = new SafeProviderAccessResolver(inner);

    const access = await safe.resolve(makeInput());

    expect(access).toEqual({ mode: "direct" });
    expect(safe.lastError).toBeInstanceOf(Error);
    expect(safe.lastError?.message).toBe("plain string failure");
  });

  test("a later successful resolve clears a previously recorded error", async () => {
    let shouldFail = true;
    const inner: ProviderAccessResolver = {
      resolve: () => {
        if (shouldFail) {
          return Promise.reject(new Error("first attempt failed"));
        }
        return Promise.resolve({ mode: "direct", tokenEnv: "RECOVERED" });
      },
    };
    const safe = new SafeProviderAccessResolver(inner);

    await safe.resolve(makeInput());
    expect(safe.lastError?.message).toBe("first attempt failed");

    shouldFail = false;
    const access = await safe.resolve(makeInput());

    expect(access).toEqual({ mode: "direct", tokenEnv: "RECOVERED" });
    expect(safe.lastError).toBeNull();
  });
});
