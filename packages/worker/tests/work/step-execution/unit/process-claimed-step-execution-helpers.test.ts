import { describe, expect, test } from "bun:test";
import {
  BASE_WORK_BRANCH_ENV_VAR,
  buildPromptRenderContext,
  resolveBaseWorkBranch,
  resolveConfiguredBaseWorkBranch,
} from "../../../../src/work/step-execution/application/process-claimed-step-execution-helpers";

describe("resolveConfiguredBaseWorkBranch", () => {
  test("prefers the env var over the jsonc-configured value", () => {
    expect(
      resolveConfiguredBaseWorkBranch({
        localEnvVars: { [BASE_WORK_BRANCH_ENV_VAR]: "feat/env" },
        configuredBaseWorkBranch: "feat/jsonc",
      }),
    ).toBe("feat/env");
  });

  test("uses the jsonc-configured value when the env var is absent", () => {
    expect(
      resolveConfiguredBaseWorkBranch({
        localEnvVars: {},
        configuredBaseWorkBranch: "feat/jsonc",
      }),
    ).toBe("feat/jsonc");
  });

  test("returns null when neither is set (use cloned default)", () => {
    expect(
      resolveConfiguredBaseWorkBranch({
        localEnvVars: {},
        configuredBaseWorkBranch: null,
      }),
    ).toBeNull();
  });

  test("treats a blank env var as unset and falls back to jsonc", () => {
    expect(
      resolveConfiguredBaseWorkBranch({
        localEnvVars: { [BASE_WORK_BRANCH_ENV_VAR]: "   " },
        configuredBaseWorkBranch: "feat/jsonc",
      }),
    ).toBe("feat/jsonc");
  });

  test("trims whitespace around the resolved value", () => {
    expect(
      resolveConfiguredBaseWorkBranch({
        localEnvVars: { [BASE_WORK_BRANCH_ENV_VAR]: "  feat/env  " },
        configuredBaseWorkBranch: null,
      }),
    ).toBe("feat/env");
  });
});

describe("resolveBaseWorkBranch", () => {
  test("passes through a server-handed branch, trimmed", () => {
    expect(resolveBaseWorkBranch("  boboddy/prev  ")).toBe("boboddy/prev");
  });

  test("returns null for empty/undefined", () => {
    expect(resolveBaseWorkBranch(null)).toBeNull();
    expect(resolveBaseWorkBranch(undefined)).toBeNull();
    expect(resolveBaseWorkBranch("   ")).toBeNull();
  });
});

describe("buildPromptRenderContext env", () => {
  const base = { inputJson: { title: "T" }, artifactsDir: "/a/" };

  test("exposes the defined worker env entries when the step declares no env", () => {
    const context = buildPromptRenderContext({
      ...base,
      env: { BASE_URL: "https://x.example.com", UNSET: undefined },
    });

    expect(context["env"]).toEqual({ BASE_URL: "https://x.example.com" });
  });

  test("replaces the worker env with promptEnv when the step declares env", () => {
    const context = buildPromptRenderContext({
      ...base,
      env: { BASE_URL: "https://x.example.com", WAREHOUSE_TOKEN: "secret" },
      promptEnv: { ACCOUNT_ID: "acct-1" },
    });

    expect(context["env"]).toEqual({ ACCOUNT_ID: "acct-1" });
  });
});
