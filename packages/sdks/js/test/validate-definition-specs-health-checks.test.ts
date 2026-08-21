import { describe, expect, test } from "bun:test";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpecWithOverrides } from "./definition-spec-fixtures";

/**
 * `validateDefinitionSpecs — health checks` — split out of
 * `validate-definition-specs.test.ts` to keep that file under the repo's
 * `max-lines` limit; see that file for the rest of `validateDefinitionSpecs`'s
 * own coverage (route targets, signal bindings, `assertValidDefinitionSpecs`).
 */
describe("validateDefinitionSpecs — health checks", () => {
  // Server key deliberately does not share a prefix with the tool's own name
  // (Playwright's MCP tools are themselves named "browser_*"), matching the
  // convention used by the shipped Playwright template (`mcp: "playwright"`).
  // Using a server key that collides with the tool's own naming (e.g. a
  // server key of "browser" for a tool called "browser_navigate") is exactly
  // the double-qualification trap this check exists to catch.
  const withMcp = (
    healthChecksJson: NonNullable<
      ReturnType<typeof stepSpecWithOverrides>["healthChecksJson"]
    >,
  ) =>
    stepSpecWithOverrides("browser-step", {
      opencodeMcpJson: {
        playwright: {
          type: "local",
          command: ["npx", "-y", "@playwright/mcp"],
        },
      },
      healthChecksJson,
    });

  test("accepts a check naming a declared MCP server with a bare tool name", () => {
    expect(
      validateDefinitionSpecs({
        pipelines: [],
        steps: [
          withMcp([
            {
              mcp: "playwright",
              tool: "browser_navigate",
              args: { url: "about:blank" },
              severity: "required",
              timeoutMs: 15000,
            },
          ]),
        ],
      }),
    ).toEqual([]);
  });

  test("accepts a check with no mcp qualifier (plugin/standalone/built-in tool)", () => {
    expect(
      validateDefinitionSpecs({
        pipelines: [],
        steps: [
          stepSpecWithOverrides("plugin-step", {
            healthChecksJson: [
              {
                tool: "my_plugin_tool",
                severity: "required",
                timeoutMs: 15000,
              },
            ],
          }),
        ],
      }),
    ).toEqual([]);
  });

  test("rejects a check naming an MCP server not declared in mcpServers", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [],
      steps: [
        withMcp([
          {
            mcp: "typo",
            tool: "browser_navigate",
            severity: "required",
            timeoutMs: 15000,
          },
        ]),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("health-check-mcp-server");
    expect(issues[0]?.message).toContain(
      'Step "browser-step" health check #1 ("browser_navigate")',
    );
    expect(issues[0]?.message).toContain('names MCP server "typo"');
    expect(issues[0]?.message).toContain("Declared servers: playwright.");
  });

  test("rejects a double-qualified tool name (server key + tool already prefixed)", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [],
      steps: [
        withMcp([
          {
            mcp: "playwright",
            tool: "playwright_browser_navigate",
            severity: "required",
            timeoutMs: 15000,
          },
        ]),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("health-check-double-qualified");
    expect(issues[0]?.message).toContain(
      'sets mcp "playwright" and tool "playwright_browser_navigate"',
    );
    expect(issues[0]?.message).toContain(
      'Did you mean tool: "browser_navigate"?',
    );
  });

  test("uses the check's name for the label when provided", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [],
      steps: [
        withMcp([
          {
            mcp: "typo",
            tool: "browser_navigate",
            name: "Browser smoke test",
            severity: "required",
            timeoutMs: 15000,
          },
        ]),
      ],
    });
    expect(issues[0]?.message).toContain(
      'health check #1 ("Browser smoke test")',
    );
  });

  test("stays quiet for a step declaring no health checks", () => {
    expect(
      validateDefinitionSpecs({
        pipelines: [],
        steps: [stepSpecWithOverrides("no-checks")],
      }),
    ).toEqual([]);
  });
});
