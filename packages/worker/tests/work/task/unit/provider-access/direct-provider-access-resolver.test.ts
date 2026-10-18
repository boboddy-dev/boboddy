import { describe, expect, test } from "bun:test";
import {
  DirectProviderAccessResolver,
  PROVIDER_ACCESS_ENV_VARS,
  ProviderAccessUnresolvedError,
  type EnvSource,
} from "../../../../../src/work/task/infra/provider-access/direct-provider-access-resolver";
import type { ListOpencodeAuthProvidersInput } from "../../../../../src/work/task/infra/provider-access/opencode-credential-discovery";
import type { ResolveProviderAccessInput } from "../../../../../src/work/task/contracts/agent-runtime/provider-access-resolver";
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

function listReturning(
  providers: string[],
  onCall?: (input: ListOpencodeAuthProvidersInput) => void,
): (input: ListOpencodeAuthProvidersInput) => Promise<string[]> {
  return (input) => {
    onCall?.(input);
    return Promise.resolve(providers);
  };
}

describe("DirectProviderAccessResolver precedence", () => {
  test("env override wins over local credentials, which are not consulted", async () => {
    let listCalled = false;
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({
        [PROVIDER_ACCESS_ENV_VARS.baseUrl]: "https://api.example.com",
        [PROVIDER_ACCESS_ENV_VARS.tokenEnv]: "MY_TOKEN",
      }),
      listProviders: listReturning(["anthropic"], () => {
        listCalled = true;
      }),
    });

    const access = await resolver.resolve(makeInput());

    expect(access).toEqual({
      mode: "direct",
      baseUrl: "https://api.example.com",
      tokenEnv: "MY_TOKEN",
    });
    expect(listCalled).toBe(false);
  });

  test("env override parses config files and headers", async () => {
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({
        [PROVIDER_ACCESS_ENV_VARS.tokenEnv]: "MY_TOKEN",
        [PROVIDER_ACCESS_ENV_VARS.configFiles]: "/a.json, /b.json",
        [PROVIDER_ACCESS_ENV_VARS.headers]: '{"x-org":"acme"}',
      }),
      listProviders: listReturning([]),
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
      listProviders: listReturning([]),
    });

    const access = await resolver.resolve(makeInput());

    expect(access.baseUrl).toBe("https://api.example.com");
    expect(access.tokenEnv).toBeUndefined();
  });

  test("resolves a bare direct access when a local credential exists", async () => {
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({}),
      listProviders: listReturning(["anthropic"]),
    });

    const access = await resolver.resolve(makeInput());

    // Credentials are injected over the server API, never via ProviderAccess.
    expect(access).toEqual({ mode: "direct" });
  });

  test("forwards the home dir and logger to the credential listing", async () => {
    const received: ListOpencodeAuthProvidersInput[] = [];
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({}),
      homeDir: "/tmp/fake-home",
      listProviders: listReturning(["anthropic"], (input) => {
        received.push(input);
      }),
    });

    await resolver.resolve(makeInput());

    expect(received[0]?.homeDir).toBe("/tmp/fake-home");
    expect(received[0]?.logger).toBeDefined();
  });

  test("throws when neither override nor a local credential is present", async () => {
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({}),
      listProviders: listReturning([]),
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
    let listCalled = false;
    const resolver = new DirectProviderAccessResolver({
      env: envFrom({
        [PROVIDER_ACCESS_ENV_VARS.baseUrl]: "   ",
        [PROVIDER_ACCESS_ENV_VARS.tokenEnv]: "",
      }),
      listProviders: listReturning(["anthropic"], () => {
        listCalled = true;
      }),
    });

    const access = await resolver.resolve(makeInput());

    expect(listCalled).toBe(true);
    expect(access).toEqual({ mode: "direct" });
  });
});
