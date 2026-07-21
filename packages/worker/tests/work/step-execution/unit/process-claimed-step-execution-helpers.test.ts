import { describe, expect, test } from "bun:test";
import {
  BASE_WORK_BRANCH_ENV_VAR,
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
