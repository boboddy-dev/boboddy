import { describe, expect, test } from "bun:test";
import {
  DirectProviderAccessResolver,
  PROVIDER_ACCESS_ENV_VARS,
  ProviderAccessUnresolvedError,
  type EnvSource,
} from "../../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";
import type {
  DiscoveredOpencodeCredential,
  DiscoverOpencodeCredentialInput,
} from "../../../../../src/work/step-execution/infra/provider-access/opencode-credential-discovery";
import type { ResolveProviderAccessInput } from "../../../../../src/work/step-execution/contracts/agent-runtime/provider-access-resolver";
import { createUuidV7 } from "../../../../../src/common/contracts/uuid-v7";

function makeInput(): ResolveProviderAccessInput {
  return {
    projectId: createUuidV7(),
    sessionId: createUuidV7(),
    requestedByUserId: createUuidV7(),
  };
}

function envFrom(values: Record<string, string>): EnvSource {
  return (name) => values[name];
}

type DiscoverDelegate = (
  input: DiscoverOpencodeCredentialInput,
) => Promise<DiscoveredOpencodeCredential | undefined>;

/**
 * Build a discover delegate that resolves to a fixed credential (or
 * `undefined`) without using an `async` body, satisfying require-await.
 */
function discoverReturning(
  credential: DiscoveredOpencodeCredential | undefined,
  onCall?: (input: DiscoverOpencodeCredentialInput) => void,
): DiscoverDelegate {
  return (input) => {
    onCall?.(input);
    return Promise.resolve(credential);
  };
}

const discoveredCredential: DiscoveredOpencodeCredential = {
  providerId: "anthropic",
  tokenEnv: "BOBODDY_PROVIDER_TOKEN",
  tokenValue: "discovered-secret",
  configFiles: ["/home/user/.local/share/opencode/auth.json"],
};

describe("DirectProviderAccessResolver precedence", () => {
  test("env override wins over discovered config", async () => {
    let discoverCalled = false;
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({
        [PROVIDER_ACCESS_ENV_VARS.baseUrl]: "https://api.example.com",
        [PROVIDER_ACCESS_ENV_VARS.tokenEnv]: "MY_TOKEN",
      }),
      discover: discoverReturning(discoveredCredential, () => {
        discoverCalled = true;
      }),
      setEnv: () => { /* no-op */ },
    });

    const access = await resolver.resolve(makeInput());

    expect(access.mode).toBe("direct");
    expect(access.baseUrl).toBe("https://api.example.com");
    expect(access.tokenEnv).toBe("MY_TOKEN");
    expect(discoverCalled).toBe(false);
  });

  test("env override parses config files and headers", async () => {
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({
        [PROVIDER_ACCESS_ENV_VARS.tokenEnv]: "MY_TOKEN",
        [PROVIDER_ACCESS_ENV_VARS.configFiles]: "/a.json, /b.json",
        [PROVIDER_ACCESS_ENV_VARS.headers]: '{"x-org":"acme"}',
      }),
      discover: discoverReturning(undefined),
      setEnv: () => { /* no-op */ },
    });

    const access = await resolver.resolve(makeInput());

    expect(access.configFiles).toEqual(["/a.json", "/b.json"]);
    expect(access.headers).toEqual({ "x-org": "acme" });
  });

  test("base-url-only override is a valid direct access", async () => {
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({
        [PROVIDER_ACCESS_ENV_VARS.baseUrl]: "https://api.example.com",
      }),
      discover: discoverReturning(undefined),
      setEnv: () => { /* no-op */ },
    });

    const access = await resolver.resolve(makeInput());

    expect(access.baseUrl).toBe("https://api.example.com");
    expect(access.tokenEnv).toBeUndefined();
  });

  test("falls back to discovered OpenCode config when no override", async () => {
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({}),
      discover: discoverReturning(discoveredCredential),
      setEnv: () => { /* no-op */ },
    });

    const access = await resolver.resolve(makeInput());

    expect(access.mode).toBe("direct");
    expect(access.tokenEnv).toBe("BOBODDY_PROVIDER_TOKEN");
    expect(access.configFiles).toEqual([
      "/home/user/.local/share/opencode/auth.json",
    ]);
    expect(access.baseUrl).toBeUndefined();
  });

  test("seeds the discovered token value into the env via setEnv", async () => {
    const injected: Record<string, string> = {};
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({}),
      discover: discoverReturning(discoveredCredential),
      setEnv: (name, value) => { injected[name] = value; },
    });

    await resolver.resolve(makeInput());

    expect(injected["BOBODDY_PROVIDER_TOKEN"]).toBe("discovered-secret");
  });

  test("forwards the logger to the discover delegate", async () => {
    const receivedInputs: DiscoverOpencodeCredentialInput[] = [];
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({}),
      discover: discoverReturning(discoveredCredential, (input) => {
        receivedInputs.push(input);
      }),
      setEnv: () => { /* no-op */ },
    });

    await resolver.resolve(makeInput());

    expect(receivedInputs[0]?.logger).toBeDefined();
  });

  test("throws when neither override nor discovered config present", async () => {
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({}),
      discover: discoverReturning(undefined),
      setEnv: () => { /* no-op */ },
    });

    let caught: unknown;
    try {
      await resolver.resolve(makeInput());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderAccessUnresolvedError);
  });

  test("blank override env values are ignored (treated as absent)", async () => {
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({
        [PROVIDER_ACCESS_ENV_VARS.baseUrl]: "   ",
        [PROVIDER_ACCESS_ENV_VARS.tokenEnv]: "",
      }),
      discover: discoverReturning(discoveredCredential),
      setEnv: () => { /* no-op */ },
    });

    const access = await resolver.resolve(makeInput());

    // Falls through to discovery because the override values were blank.
    expect(access.tokenEnv).toBe("BOBODDY_PROVIDER_TOKEN");
  });
});
