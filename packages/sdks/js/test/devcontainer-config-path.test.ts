import { describe, expect, test } from "bun:test";
import {
  devcontainerConfigPathSchema,
  MAX_DEVCONTAINER_CONFIG_PATH_LENGTH,
  normalizeDevcontainerConfigPath,
} from "../src/devcontainer-config-path";

const parse = (path: string) => devcontainerConfigPathSchema.safeParse(path);

function messageFor(path: string): string {
  const result = parse(path);
  if (result.success) throw new Error(`expected "${path}" to be rejected`);
  return result.error.issues.map((issue) => issue.message).join("; ");
}

describe("devcontainerConfigPathSchema — accepted shapes", () => {
  test.each([
    "devcontainer.json",
    ".devcontainer.json",
    ".devcontainer/devcontainer.json",
    ".devcontainer/frontend/devcontainer.json",
    ".devcontainer/frontend/.devcontainer.json",
    "tools/perf/devcontainer.json",
    "packages/web/.devcontainer/devcontainer.json",
  ])("accepts %s unchanged", (path) => {
    const result = parse(path);
    expect(result.success).toBe(true);
    expect(result.data).toBe(path);
  });

  test("accepts a path of exactly the maximum length", () => {
    const suffix = "/devcontainer.json";
    const path = `${"a".repeat(MAX_DEVCONTAINER_CONFIG_PATH_LENGTH - suffix.length)}${suffix}`;
    expect(path).toHaveLength(MAX_DEVCONTAINER_CONFIG_PATH_LENGTH);
    expect(parse(path).success).toBe(true);
  });
});

describe("devcontainerConfigPathSchema — leading ./ normalization", () => {
  test("strips a leading ./", () => {
    expect(parse("./.devcontainer/devcontainer.json").data).toBe(
      ".devcontainer/devcontainer.json",
    );
  });

  test("strips repeated leading ./ segments", () => {
    expect(parse("././devcontainer.json").data).toBe("devcontainer.json");
  });

  test("leaves an interior ./ segment alone", () => {
    expect(parse("a/./devcontainer.json").data).toBe("a/./devcontainer.json");
  });

  test("validates the normalized path", () => {
    expect(messageFor(".//etc/devcontainer.json")).toContain("relative");
    expect(messageFor("./")).toContain("devcontainer.json");
  });

  test("normalizeDevcontainerConfigPath only touches the leading prefix", () => {
    expect(normalizeDevcontainerConfigPath("./x/devcontainer.json")).toBe(
      "x/devcontainer.json",
    );
    expect(normalizeDevcontainerConfigPath("x/devcontainer.json")).toBe(
      "x/devcontainer.json",
    );
    expect(normalizeDevcontainerConfigPath(".devcontainer.json")).toBe(
      ".devcontainer.json",
    );
  });
});

describe("devcontainerConfigPathSchema — rejections", () => {
  test("rejects a leading slash", () => {
    expect(messageFor("/etc/devcontainer.json")).toContain("relative");
  });

  test.each(["C:/work/devcontainer.json", "c:devcontainer.json"])(
    "rejects the drive letter in %s",
    (path) => {
      expect(messageFor(path)).toContain("relative");
    },
  );

  test("rejects windows separators", () => {
    expect(messageFor(".devcontainer\\devcontainer.json")).toContain(
      "backslash",
    );
  });

  test("rejects a windows absolute path", () => {
    const message = messageFor("C:\\work\\devcontainer.json");
    expect(message).toContain("backslash");
    expect(message).toContain("relative");
  });

  test.each([
    "../devcontainer.json",
    ".devcontainer/../devcontainer.json",
    "a/b/../../devcontainer.json",
    ".devcontainer/..",
  ])("rejects the .. segment in %s", (path) => {
    expect(messageFor(path)).toContain('".."');
  });

  test("allows .. inside a segment name", () => {
    expect(parse("a..b/devcontainer.json").success).toBe(true);
  });

  test.each([
    "",
    ".devcontainer",
    ".devcontainer/",
    ".devcontainer/other.json",
    ".devcontainer/devcontainer.jsonc",
    ".devcontainer/Devcontainer.json",
    ".devcontainer/xdevcontainer.json",
    ".devcontainer/devcontainer.json/",
    ".devcontainer/devcontainer.json.bak",
  ])("rejects the basename in %j", (path) => {
    expect(messageFor(path)).toContain("devcontainer.json");
  });

  test("rejects a path over the maximum length", () => {
    const suffix = "/devcontainer.json";
    const path = `${"a".repeat(MAX_DEVCONTAINER_CONFIG_PATH_LENGTH - suffix.length + 1)}${suffix}`;
    expect(path).toHaveLength(MAX_DEVCONTAINER_CONFIG_PATH_LENGTH + 1);
    expect(parse(path).success).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(devcontainerConfigPathSchema.safeParse(undefined).success).toBe(
      false,
    );
    expect(devcontainerConfigPathSchema.safeParse(42).success).toBe(false);
  });
});

describe("devcontainerConfigPathSchema — JSON schema", () => {
  test("is representable as a plain string schema", async () => {
    const { z } = await import("zod");
    const json = z.toJSONSchema(devcontainerConfigPathSchema, { io: "input" });
    expect(json).toMatchObject({
      type: "string",
      maxLength: MAX_DEVCONTAINER_CONFIG_PATH_LENGTH,
    });
  });
});
