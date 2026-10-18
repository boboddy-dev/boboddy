import { describe, expect, test } from "bun:test";
import { Env, Runtime, defineStep } from "../src";

describe("defineStep — environment.vars applies", () => {
  test("Env helpers carry applies and omit the agent default", () => {
    const spec = defineStep({
      key: "s",
      name: "S",
      environment: {
        runtime: Runtime.devcontainer(),
        vars: () => ({
          AGENT_ONLY: Env.value({ value: "a" }),
          EXPLICIT_AGENT: Env.value({ value: "b", applies: "agent" }),
          NPM_TOKEN: Env.inherit({ secret: true, applies: "setup" }),
          REGISTRY: Env.value({ value: "r", applies: "both" }),
        }),
      },
      agentPrompt: "go",
    });
    expect(spec.envJson).toEqual([
      { name: "AGENT_ONLY", source: "value", value: "a", secret: false },
      { name: "EXPLICIT_AGENT", source: "value", value: "b", secret: false },
      {
        name: "NPM_TOKEN",
        source: "inherit",
        from: "NPM_TOKEN",
        secret: true,
        optional: false,
        applies: "setup",
      },
      {
        name: "REGISTRY",
        source: "value",
        value: "r",
        secret: false,
        applies: "both",
      },
    ]);
  });

  test("a setup var on Runtime.host() throws", () => {
    expect(() =>
      defineStep({
        key: "host-step",
        name: "Host",
        environment: {
          runtime: Runtime.host(),
          vars: () => ({ NPM_TOKEN: Env.inherit({ applies: "setup" }) }),
        },
        agentPrompt: "go",
      }),
    ).toThrow('applies "setup"');
  });
});
