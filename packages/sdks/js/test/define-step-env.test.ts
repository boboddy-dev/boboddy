import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Env, Runtime, codeStep, defineStep } from "../src";
import {
  normalizeEnv,
  type EnvValue,
  type PromptEnv,
} from "../src/definitions/steps/env";

describe("defineStep — environment.vars type inference", () => {
  test("vars declared before agentPrompt types the prompt's env strictly", () => {
    defineStep({
      key: "typed",
      name: "Typed",
      additionalInput: z.object({ accountId: z.string() }),
      environment: {
        runtime: Runtime.devcontainer(),
        vars: ({ input }) => ({
          ACCOUNT_ID: input.accountId,
          INPUT_SECRET: Env.value({
            value: `${input.accountId}-k`,
            secret: true,
          }),
          INPUT_PLAIN: Env.value({ value: `${input.accountId}-p` }),
          INPUT_EXPLICIT_PLAIN: Env.value({
            value: `${input.accountId}-e`,
            secret: false,
          }),
          WAREHOUSE_TOKEN: Env.inherit({ secret: true }),
          LOG_LEVEL: Env.inherit({ optional: true }),
          MODE: Env.inherit({ optional: true, default: "fast" }),
        }),
      },
      agentPrompt: ({ env }) => {
        const accountId: string = env.ACCOUNT_ID;
        const plain: string = env.INPUT_PLAIN;
        const explicitPlain: string = env.INPUT_EXPLICIT_PLAIN;
        const mode: string = env.MODE;
        const logLevel: string | undefined = env.LOG_LEVEL;
        // @ts-expect-error an optional entry without a default may be undefined
        const requiredLogLevel: string = env.LOG_LEVEL;
        // @ts-expect-error secret inherit keys are dropped from the prompt env
        void env.WAREHOUSE_TOKEN;
        // @ts-expect-error secret value keys are dropped from the prompt env
        void env.INPUT_SECRET;
        // @ts-expect-error undeclared keys are rejected once vars is declared
        void env.NOT_DECLARED;
        return [
          accountId,
          plain,
          explicitPlain,
          mode,
          logLevel,
          requiredLogLevel,
        ].join(" ");
      },
    });
  });

  test("vars input is typed from additionalInput", () => {
    defineStep({
      key: "typed-input",
      name: "Typed Input",
      additionalInput: z.object({ accountId: z.string() }),
      environment: {
        vars: ({ input }) => {
          // @ts-expect-error unknown input fields are rejected
          void input.notAField;
          return { ACCOUNT_ID: input.accountId };
        },
      },
      agentPrompt: "go",
    });
  });

  test("without environment, the prompt's env stays a loose record", () => {
    defineStep({
      key: "loose",
      name: "Loose",
      agentPrompt: ({ env }) => String(env.ANYTHING),
    });
  });

  test("environment with only a runtime leaves the prompt's env a loose record", () => {
    defineStep({
      key: "loose-runtime",
      name: "Loose Runtime",
      environment: { runtime: Runtime.host() },
      agentPrompt: ({ env }) => String(env.ANYTHING),
    });
  });

  test("the removed top-level env and executionMode options are rejected", () => {
    defineStep({
      key: "removed",
      name: "Removed",
      // @ts-expect-error `env` moved to environment.vars
      env: () => ({ A: "x" }),
      agentPrompt: "go",
    });
    defineStep({
      key: "removed-mode",
      name: "Removed Mode",
      // @ts-expect-error `executionMode` moved to environment.runtime
      executionMode: "no_workspace",
      agentPrompt: "go",
    });
  });

  test("PromptEnv drops secret keys and keeps the rest", () => {
    const kept: PromptEnv<{ A: string; B: EnvValue<false> }> = {
      A: "a",
      B: "b",
    };
    const dropped: PromptEnv<{ A: string; B: EnvValue<true> }> = {
      A: "a",
      // @ts-expect-error B is secret, so it is not part of the prompt env
      B: "b",
    };
    expect([kept, dropped]).toHaveLength(2);
  });

  test("Env.inherit rejects secret together with default", () => {
    // @ts-expect-error a secret cannot carry a default
    Env.inherit({ secret: true, default: "x" });
    Env.inherit({ secret: false, default: "x" });
    Env.inherit({ secret: true, optional: true });
  });

  test("codeStep accepts environment.vars and normalizes it", () => {
    const spec = codeStep({
      key: "code",
      name: "Code",
      inputSchema: z.object({ accountId: z.string() }),
      environment: {
        vars: ({ input }) => ({
          ACCOUNT_ID: input.accountId,
          LOG_LEVEL: Env.inherit({ optional: true }),
        }),
      },
      fn: () => ({}),
    });
    expect(spec.envJson).toEqual([
      {
        name: "ACCOUNT_ID",
        source: "value",
        value: "{{input.accountId}}",
        secret: false,
      },
      {
        name: "LOG_LEVEL",
        source: "inherit",
        from: "LOG_LEVEL",
        secret: false,
        optional: true,
      },
    ]);
  });

  test("codeStep rejects the removed top-level env option", () => {
    codeStep({
      key: "code",
      name: "Code",
      // @ts-expect-error `env` moved to environment.vars
      env: () => ({ A: "x" }),
      fn: () => ({}),
    });
  });

  test("codeStep emits null envJson when vars is not declared", () => {
    const spec = codeStep({ key: "code", name: "Code", fn: () => ({}) });
    expect(spec.envJson).toBeNull();
  });
});

describe("defineStep — environment.vars normalization", () => {
  test("emits null envJson when vars is not declared", () => {
    const spec = defineStep({ key: "s", name: "S", agentPrompt: "go" });
    expect(spec.envJson).toBeNull();
  });

  test("normalizes every authoring form", () => {
    const spec = defineStep({
      key: "s",
      name: "S",
      additionalInput: z.object({ accountId: z.string(), tenant: z.string() }),
      environment: {
        vars: ({ input }) => ({
          WAREHOUSE_URL: "https://warehouse.internal",
          ACCOUNT_ID: input.accountId,
          TENANT_URL: `https://${input.tenant}.example.com`,
          TENANT_API_KEY: Env.value({
            value: `${input.tenant}-key`,
            secret: true,
          }),
          WAREHOUSE_TOKEN: Env.inherit({ secret: true }),
          DB_PASSWORD: Env.inherit({
            from: "STAGING_DB_PASSWORD",
            secret: true,
          }),
          LOG_LEVEL: Env.inherit({ optional: true, default: "info" }),
          SENTRY_DSN: Env.inherit(),
        }),
      },
      agentPrompt: ({ env }) => `Query ${env.WAREHOUSE_URL}`,
    });
    expect(spec.envJson).toEqual([
      {
        name: "WAREHOUSE_URL",
        source: "value",
        value: "https://warehouse.internal",
        secret: false,
      },
      {
        name: "ACCOUNT_ID",
        source: "value",
        value: "{{input.accountId}}",
        secret: false,
      },
      {
        name: "TENANT_URL",
        source: "value",
        value: "https://{{input.tenant}}.example.com",
        secret: false,
      },
      {
        name: "TENANT_API_KEY",
        source: "value",
        value: "{{input.tenant}}-key",
        secret: true,
      },
      {
        name: "WAREHOUSE_TOKEN",
        source: "inherit",
        from: "WAREHOUSE_TOKEN",
        secret: true,
        optional: false,
      },
      {
        name: "DB_PASSWORD",
        source: "inherit",
        from: "STAGING_DB_PASSWORD",
        secret: true,
        optional: false,
      },
      {
        name: "LOG_LEVEL",
        source: "inherit",
        from: "LOG_LEVEL",
        secret: false,
        optional: true,
        default: "info",
      },
      {
        name: "SENTRY_DSN",
        source: "inherit",
        from: "SENTRY_DSN",
        secret: false,
        optional: false,
      },
    ]);
  });

  test("agentPrompt renders env references as {{env.X}} tokens", () => {
    const spec = defineStep({
      key: "s",
      name: "S",
      environment: {
        vars: () => ({ WAREHOUSE_URL: "https://warehouse.internal" }),
      },
      agentPrompt: ({ env }) => `Query ${env.WAREHOUSE_URL}`,
    });
    expect(spec.prompt).toBe("Query {{env.WAREHOUSE_URL}}");
  });

  test("an empty vars record normalizes to null", () => {
    expect(normalizeEnv(() => ({}))).toBeNull();
  });

  test("runs the vars function exactly once", () => {
    let calls = 0;
    defineStep({
      key: "s",
      name: "S",
      environment: {
        vars: () => {
          calls += 1;
          return { A: "x" };
        },
      },
      agentPrompt: "go",
    });
    expect(calls).toBe(1);
  });

  test("vars and runtime compile independently", () => {
    const spec = defineStep({
      key: "s",
      name: "S",
      environment: {
        runtime: Runtime.devcontainer({
          config: ".devcontainer/alt/devcontainer.json",
        }),
        vars: () => ({ A: "x" }),
      },
      agentPrompt: "go",
    });
    expect(spec.executionMode).toBe("workspace");
    expect(spec.devcontainerConfigPath).toBe(
      ".devcontainer/alt/devcontainer.json",
    );
    expect(spec.envJson).toEqual([
      { name: "A", source: "value", value: "x", secret: false },
    ]);
  });
});

describe("defineStep — environment.vars definition-time guards", () => {
  test("rejects a static secret", () => {
    expect(() =>
      defineStep({
        key: "s",
        name: "S",
        environment: {
          vars: () => ({
            ANYTHING: Env.value({ value: "hunter2", secret: true }),
          }),
        },
        agentPrompt: "go",
      }),
    ).toThrow(/static secret/);
  });

  test("rejects a static secret even with unsafeAllowStatic", () => {
    expect(() =>
      defineStep({
        key: "s",
        name: "S",
        environment: {
          vars: () => ({
            ANYTHING: Env.value({
              value: "hunter2",
              secret: true,
              unsafeAllowStatic: true,
            }),
          }),
        },
        agentPrompt: "go",
      }),
    ).toThrow(/static secret/);
  });

  test("rejects a bare static literal on a secret-looking name, without echoing the value", () => {
    let message = "";
    try {
      defineStep({
        key: "s",
        name: "S",
        environment: { vars: () => ({ STRIPE_API_KEY: "sk_live_abc123" }) },
        agentPrompt: "go",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("STRIPE_API_KEY");
    expect(message).not.toContain("sk_live_abc123");
  });

  test("rejects an Env.value static literal on a secret-looking name", () => {
    expect(() =>
      defineStep({
        key: "s",
        name: "S",
        environment: {
          vars: () => ({ DB_PASSWORD: Env.value({ value: "pw" }) }),
        },
        agentPrompt: "go",
      }),
    ).toThrow(/secret-looking name/);
  });

  test("unsafeAllowStatic lets a static literal through and is never serialized", () => {
    const spec = defineStep({
      key: "s",
      name: "S",
      environment: {
        vars: () => ({
          TOKEN_ENDPOINT: Env.value({
            value: "https://auth.example.com/token",
            unsafeAllowStatic: true,
          }),
        }),
      },
      agentPrompt: "go",
    });
    expect(spec.envJson).toEqual([
      {
        name: "TOKEN_ENDPOINT",
        source: "value",
        value: "https://auth.example.com/token",
        secret: false,
      },
    ]);
  });

  test("allows an interpolated value on a secret-looking name", () => {
    const spec = defineStep({
      key: "s",
      name: "S",
      additionalInput: z.object({ tenant: z.string() }),
      environment: {
        vars: ({ input }) => ({ TENANT_TOKEN: `${input.tenant}-x` }),
      },
      agentPrompt: "go",
    });
    expect(spec.envJson?.[0]?.name).toBe("TENANT_TOKEN");
  });
});
