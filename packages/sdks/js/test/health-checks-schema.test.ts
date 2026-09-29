import { describe, expect, test } from "bun:test";
import { healthCheckSchema } from "../src/health-checks";

describe("healthCheckSchema", () => {
  test.concurrent("normalizes a legacy no-kind shape to kind: 'tool'", () => {
    const result = healthCheckSchema.parse({
      tool: "browser_navigate",
      mcp: "playwright",
    });
    expect(result).toEqual({
      kind: "tool",
      tool: "browser_navigate",
      mcp: "playwright",
      severity: "required",
      timeoutMs: 15000,
    });
  });

  test.concurrent("parses an explicit kind: 'tool' shape unchanged", () => {
    const result = healthCheckSchema.parse({
      kind: "tool",
      tool: "my_plugin_tool",
    });
    expect(result).toMatchObject({ kind: "tool", tool: "my_plugin_tool" });
  });

  test.concurrent("rejects an unknown extra field on the tool arm", () => {
    expect(() =>
      healthCheckSchema.parse({
        tool: "browser_navigate",
        bogus: "field",
      }),
    ).toThrow();
  });

  test.concurrent("parses a kind: 'cli' shape, defaulting expectExitCode to 0", () => {
    const result = healthCheckSchema.parse({
      kind: "cli",
      command: ["gh", "--version"],
    });
    expect(result).toEqual({
      kind: "cli",
      command: ["gh", "--version"],
      expectExitCode: 0,
      severity: "required",
      timeoutMs: 15000,
    });
  });

  test.concurrent("rejects a cli check with a missing command", () => {
    expect(() =>
      healthCheckSchema.parse({
        kind: "cli",
      }),
    ).toThrow();
  });

  test.concurrent("rejects a cli check with an empty command array", () => {
    expect(() =>
      healthCheckSchema.parse({
        kind: "cli",
        command: [],
      }),
    ).toThrow();
  });

  test.concurrent("rejects a cli check whose command contains an empty string", () => {
    expect(() =>
      healthCheckSchema.parse({
        kind: "cli",
        command: ["gh", ""],
      }),
    ).toThrow();
  });

  test.concurrent("rejects an unknown extra field on the cli arm", () => {
    expect(() =>
      healthCheckSchema.parse({
        kind: "cli",
        command: ["gh", "--version"],
        tool: "not-allowed-here",
      }),
    ).toThrow();
  });

  test.concurrent("rejects an unknown kind literal with a clear discriminant error", () => {
    let error: unknown;
    try {
      healthCheckSchema.parse({ kind: "skill", tool: "whatever" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("kind");
  });
});
