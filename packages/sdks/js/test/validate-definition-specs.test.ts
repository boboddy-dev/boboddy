import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { PipelineDefinitionSpec } from "../src/definitions/pipelines";
import {
  assertValidDefinitionSpecs,
  validateDefinitionSpecs,
} from "../src/definitions/validation";
import {
  pipelineSpec,
  pipelineStep,
  stepSpec,
  stepSpecWithOverrides,
  type Bindings,
} from "./definition-spec-fixtures";

describe("validateDefinitionSpecs — route targets", () => {
  const routing = (target: string): PipelineDefinitionSpec =>
    pipelineSpec("router", [
      pipelineStep("classify", 1, {
        advancementPolicyDefinition: {
          rulesJson: {
            rules: [
              {
                conditions: { all: [] },
                event: { type: "route", params: { pipelineKey: target } },
              },
            ],
          },
          defaultEventType: "route",
          defaultEventParamsJson: { pipelineKey: target },
          allowedEventTypes: ["route"],
        },
      }),
    ]);

  test("accepts a target present in the same batch", () => {
    expect(
      validateDefinitionSpecs({
        pipelines: [routing("target"), pipelineSpec("target", [])],
        steps: [],
      }),
    ).toEqual([]);
  });

  test("accepts a target only known to the server", () => {
    expect(
      validateDefinitionSpecs(
        { pipelines: [routing("target")], steps: [] },
        { knownPipelineKeys: ["target"] },
      ),
    ).toEqual([]);
  });

  test("rejects a target nowhere to be found, once per reference", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [routing("missing-target")],
      steps: [],
    });
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.check).toBe("route-target");
      expect(issue.message).toContain('routes to pipeline "missing-target"');
      expect(issue.message).toContain('Pipeline "router" step "classify"');
    }
  });
});

describe("validateDefinitionSpecs — signal bindings", () => {
  const producer = stepSpec("produce", z.object({ out: z.string() }), ["out"]);
  const consumer = stepSpec("consume", z.object({ done: z.boolean() }), [
    "done",
  ]);

  const binding = (
    bindings: Bindings,
    reverse = false,
  ): PipelineDefinitionSpec => {
    const steps = [
      pipelineStep("produce", 1),
      pipelineStep("consume", 2, { inputBindingsJson: bindings }),
    ];
    return pipelineSpec("p", reverse ? [...steps].reverse() : steps);
  };

  test("accepts a signal from an earlier step", () => {
    expect(
      validateDefinitionSpecs({
        pipelines: [
          binding({
            ctx: {
              source: "step_signal",
              stepKey: "produce",
              signalKey: "out",
            },
          }),
        ],
        steps: [producer, consumer],
      }),
    ).toEqual([]);
  });

  test("accepts step_output from an earlier step", () => {
    expect(
      validateDefinitionSpecs({
        pipelines: [
          binding({ ctx: { source: "step_output", stepKey: "produce" } }),
        ],
        steps: [producer, consumer],
      }),
    ).toEqual([]);
  });

  test("rejects a reference to a step that is not in the pipeline", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        binding({
          ctx: { source: "step_signal", stepKey: "ghost", signalKey: "out" },
        }),
      ],
      steps: [producer, consumer],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain(
      "no step with that key is in the pipeline",
    );
    expect(issues[0]?.message).toContain("produce → consume");
  });

  test("rejects a reference to a later step, ordering by position", () => {
    // Array order is reversed, so only `position` proves which runs first.
    const issues = validateDefinitionSpecs({
      pipelines: [
        binding(
          {
            ctx: {
              source: "step_signal",
              stepKey: "consume",
              signalKey: "done",
            },
          },
          true,
        ),
      ],
      steps: [producer, consumer],
    });
    // `consume` binding a signal of itself never resolves either.
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("does not run before it");
  });

  test("rejects a signal the producing step does not declare", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        binding({
          ctx: { source: "step_signal", stepKey: "produce", signalKey: "nope" },
        }),
      ],
      steps: [producer, consumer],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("declares no such signal");
    expect(issues[0]?.message).toContain('Signals on "produce": out.');
  });

  test("accepts a computed signal declared on the producing pipeline step", () => {
    const steps = [
      pipelineStep("produce", 1, {
        computedSignalDefinitions: [
          {
            key: "avg_out",
            type: "average",
            inputSignalKeys: ["out"],
            configJson: null,
            availableWhenResultStatusIn: null,
          },
        ],
      }),
      pipelineStep("consume", 2, {
        inputBindingsJson: {
          ctx: {
            source: "step_signal",
            stepKey: "produce",
            signalKey: "avg_out",
          },
        },
      }),
    ];
    expect(
      validateDefinitionSpecs({
        pipelines: [pipelineSpec("p", steps)],
        steps: [producer, consumer],
      }),
    ).toEqual([]);
  });

  test("stays quiet when the producing step is not in the batch at all", () => {
    expect(
      validateDefinitionSpecs({
        pipelines: [
          binding({
            ctx: { source: "step_signal", stepKey: "produce", signalKey: "?" },
          }),
        ],
        steps: [consumer],
      }),
    ).toEqual([]);
  });

  test("ignores bindings that do not reference a step", () => {
    expect(
      validateDefinitionSpecs({
        pipelines: [
          binding({
            a: { source: "work_item", field: "title" },
            b: { source: "literal", value: 1 },
            c: { source: "pipeline_input", path: "x" },
          }),
        ],
        steps: [producer, consumer],
      }),
    ).toEqual([]);
  });
});

describe("validateDefinitionSpecs — health checks", () => {
  // Server key deliberately does not share a prefix with the tool's own name
  // (Playwright's MCP tools are themselves named "browser_*"), matching the
  // convention used by the shipped Playwright template (`mcp: "playwright"`).
  // Using a server key that collides with the tool's own naming (e.g. a
  // server key of "browser" for a tool called "browser_navigate") is exactly
  // the double-qualification trap this check exists to catch.
  const withMcp = (healthChecksJson: NonNullable<ReturnType<typeof stepSpecWithOverrides>["healthChecksJson"]>) =>
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
              { tool: "my_plugin_tool", severity: "required", timeoutMs: 15000 },
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
    expect(issues[0]?.message).toContain('Step "browser-step" health check #1 ("browser_navigate")');
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
    expect(issues[0]?.message).toContain('sets mcp "playwright" and tool "playwright_browser_navigate"');
    expect(issues[0]?.message).toContain('Did you mean tool: "browser_navigate"?');
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
    expect(issues[0]?.message).toContain('health check #1 ("Browser smoke test")');
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

describe("assertValidDefinitionSpecs", () => {
  test("does nothing for a clean batch", () => {
    expect(() => {
      assertValidDefinitionSpecs({ pipelines: [], steps: [] });
    }).not.toThrow();
  });

  test("aggregates every issue into one error", () => {
    let caught: unknown;
    try {
      assertValidDefinitionSpecs({
        pipelines: [],
        steps: [
          stepSpec("a", z.object({ x: z.string() }), ["nope"]),
          stepSpec("b", z.object({ y: z.string() }), ["also-nope"]),
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("Definition validation failed with 2 problems");
    expect(message).toContain('Step "a"');
    expect(message).toContain('Step "b"');
  });
});
