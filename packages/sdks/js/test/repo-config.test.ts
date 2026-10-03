import { describe, expect, test } from "bun:test";
import {
  MAX_REPO_COMMIT_MESSAGE_LENGTH,
  REPO_RUNTIME_SUPPORT,
  findDisallowedCommitMessageTokenRoots,
  repoConfigInputSchema,
  repoConfigSchema,
  repoRuntimeMismatch,
  resolveRepoConfig,
  type RepoConfig,
  type RepoMode,
} from "../src/repo-config";

describe("repoConfigInputSchema", () => {
  test.each([
    [{ mode: "none" }],
    [{ mode: "readOnly" }],
    [{ mode: "readWrite" }],
    [{ mode: "readWrite", message: "fix: {{result.summary}}" }],
    [{ mode: "readWrite", onPushFailure: "warn" }],
    [{ mode: "readWrite", message: "{{input.title}}", onPushFailure: "fail" }],
  ])("accepts %j", (input) => {
    expect(repoConfigInputSchema.safeParse(input).success).toBe(true);
  });

  test.each([
    [{}, "no mode"],
    [{ mode: "write" }, "unknown mode"],
    [{ mode: "read_write" }, "snake_case mode"],
    [{ mode: "none", message: "x" }, "message on none"],
    [{ mode: "readOnly", message: "x" }, "message on readOnly"],
    [{ mode: "readOnly", onPushFailure: "fail" }, "onPushFailure on readOnly"],
    [{ mode: "readWrite", onPushFailure: "ignore" }, "unknown onPushFailure"],
    [{ mode: "readWrite", message: 3 }, "non-string message"],
    [{ mode: "readWrite", extra: true }, "unknown key"],
  ])("rejects %j (%s)", (input) => {
    expect(repoConfigInputSchema.safeParse(input).success).toBe(false);
  });

  test("a resolved RepoConfig is a valid input", () => {
    const resolved: RepoConfig[] = [
      { mode: "none" },
      { mode: "readOnly" },
      { mode: "readWrite", message: null, onPushFailure: "fail" },
      { mode: "readWrite", message: "x {{input.a}}", onPushFailure: "warn" },
    ];
    for (const config of resolved) {
      expect(repoConfigInputSchema.safeParse(config).success).toBe(true);
    }
  });
});

describe("repoConfigSchema", () => {
  test("accepts every resolved shape", () => {
    for (const config of [
      { mode: "none" },
      { mode: "readOnly" },
      { mode: "readWrite", message: null, onPushFailure: "fail" },
      { mode: "readWrite", message: "m", onPushFailure: "warn" },
    ]) {
      expect(repoConfigSchema.safeParse(config).success).toBe(true);
    }
  });

  test("requires message and onPushFailure on readWrite", () => {
    expect(repoConfigSchema.safeParse({ mode: "readWrite" }).success).toBe(
      false,
    );
    expect(
      repoConfigSchema.safeParse({ mode: "readWrite", onPushFailure: "fail" })
        .success,
    ).toBe(false);
    expect(
      repoConfigSchema.safeParse({ mode: "readWrite", message: null }).success,
    ).toBe(false);
  });

  test("applies the message rules to a stored message", () => {
    expect(
      repoConfigSchema.safeParse({
        mode: "readWrite",
        message: "{{env.TOKEN}}",
        onPushFailure: "fail",
      }).success,
    ).toBe(false);
  });
});

describe("commit message rule", () => {
  const parse = (message: string) =>
    repoConfigInputSchema.safeParse({ mode: "readWrite", message });

  test("accepts exactly the maximum length", () => {
    expect(parse("a".repeat(MAX_REPO_COMMIT_MESSAGE_LENGTH)).success).toBe(
      true,
    );
  });

  test("rejects one character over the maximum", () => {
    expect(parse("a".repeat(MAX_REPO_COMMIT_MESSAGE_LENGTH + 1)).success).toBe(
      false,
    );
  });

  test.each(["line one\nline two", "line one\r\nline two", "a\rb"])(
    "rejects a newline in %j",
    (message) => {
      const result = parse(message);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("single line");
    },
  );

  test.each([
    "{{input.title}}",
    "{{result.summary}}",
    "{{input.a.b}} and {{result.c}}",
    "{{input}}",
    "no tokens at all",
    "unterminated {{env.X",
  ])("accepts %j", (message) => {
    expect(parse(message).success).toBe(true);
  });

  test.each([
    "{{env.SECRET}}",
    "{{boboddy.artifactsDir}}",
    "ok {{input.a}} then {{env.B}}",
    "{{ input.spaced }}",
    "{{inputs.title}}",
    "{{other}}",
  ])("rejects the token root in %j", (message) => {
    const result = parse(message);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("tokens");
  });

  test("lists the disallowed roots in order", () => {
    expect(
      findDisallowedCommitMessageTokenRoots(
        "{{env.A}} {{input.b}} {{boboddy.c}} {{result.d}}",
      ),
    ).toEqual(["env", "boboddy"]);
  });
});

describe("compatibility table", () => {
  const cells: Array<[RepoMode, "workspace" | "no_workspace", boolean]> = [
    ["readWrite", "workspace", true],
    ["readOnly", "workspace", true],
    ["none", "workspace", false],
    ["readWrite", "no_workspace", false],
    ["readOnly", "no_workspace", false],
    ["none", "no_workspace", true],
  ];

  test.each(cells)("%s on %s: supported=%p", (mode, executionMode, ok) => {
    const mismatch = repoRuntimeMismatch(executionMode, mode);
    expect(mismatch === null).toBe(ok);
  });

  test("states why each runtime rejects", () => {
    expect(repoRuntimeMismatch("no_workspace", "readWrite")).toBe(
      "a host step has no clone",
    );
    expect(repoRuntimeMismatch("workspace", "none")).toBe(
      "a devcontainer step reads its config from the clone",
    );
  });

  test("each default is one of the runtime's own modes", () => {
    for (const support of Object.values(REPO_RUNTIME_SUPPORT)) {
      expect(support.modes).toContain(support.default);
    }
  });
});

describe("resolveRepoConfig", () => {
  test("an omitted repo becomes readWrite for a workspace step", () => {
    expect(resolveRepoConfig("workspace", undefined)).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
    });
  });

  test("an omitted repo becomes none for a no_workspace step", () => {
    expect(resolveRepoConfig("no_workspace", undefined)).toEqual({
      mode: "none",
    });
  });

  test("null is treated as omitted", () => {
    expect(resolveRepoConfig("workspace", null)).toEqual(
      resolveRepoConfig("workspace", undefined),
    );
  });

  test("readWrite fills an omitted message and onPushFailure", () => {
    expect(resolveRepoConfig("workspace", { mode: "readWrite" })).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
    });
  });

  test("readWrite fills only the omitted field", () => {
    expect(
      resolveRepoConfig("workspace", { mode: "readWrite", message: "m" }),
    ).toEqual({ mode: "readWrite", message: "m", onPushFailure: "fail" });
    expect(
      resolveRepoConfig("workspace", {
        mode: "readWrite",
        onPushFailure: "warn",
      }),
    ).toEqual({ mode: "readWrite", message: null, onPushFailure: "warn" });
  });

  test("readOnly and none pass through", () => {
    expect(resolveRepoConfig("workspace", { mode: "readOnly" })).toEqual({
      mode: "readOnly",
    });
    expect(resolveRepoConfig("no_workspace", { mode: "none" })).toEqual({
      mode: "none",
    });
  });

  test("is idempotent on a resolved config", () => {
    const resolved = resolveRepoConfig("workspace", {
      mode: "readWrite",
      message: "{{result.summary}}",
      onPushFailure: "warn",
    });
    expect(resolveRepoConfig("workspace", resolved)).toEqual(resolved);
  });

  test("output satisfies repoConfigSchema", () => {
    for (const [executionMode, input] of [
      ["workspace", undefined],
      ["workspace", { mode: "readOnly" }],
      ["workspace", { mode: "readWrite", message: "m" }],
      ["no_workspace", undefined],
      ["no_workspace", { mode: "none" }],
    ] as const) {
      expect(
        repoConfigSchema.safeParse(resolveRepoConfig(executionMode, input))
          .success,
      ).toBe(true);
    }
  });
});
