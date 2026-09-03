import { describe, expect, test } from "bun:test";
import type { DefinitionValidationIssue } from "@boboddy/sdk/definitions/validation";
import type { StudioNodeShape } from "./studio-graph-types";
import {
  formatInOutCounts,
  highestSeverity,
  nodeInOutCounts,
  severityColor,
} from "./studio-graph-visuals";

function issue(
  overrides: Partial<DefinitionValidationIssue> & {
    severity: DefinitionValidationIssue["severity"];
  },
): DefinitionValidationIssue {
  return {
    check: "route-target",
    message: "message",
    ...overrides,
  };
}

describe("highestSeverity", () => {
  test("returns null for an empty issue list", () => {
    expect(highestSeverity([])).toBeNull();
  });

  test("returns 'info' when every issue is info", () => {
    expect(highestSeverity([issue({ severity: "info" })])).toBe("info");
  });

  test("returns 'warning' when every issue is a warning", () => {
    expect(highestSeverity([issue({ severity: "warning" })])).toBe("warning");
  });

  test("returns 'warning' over 'info', regardless of order", () => {
    expect(
      highestSeverity([issue({ severity: "info" }), issue({ severity: "warning" })]),
    ).toBe("warning");
    expect(
      highestSeverity([issue({ severity: "warning" }), issue({ severity: "info" })]),
    ).toBe("warning");
  });

  test("returns 'error' when any issue is an error, regardless of order", () => {
    expect(
      highestSeverity([issue({ severity: "warning" }), issue({ severity: "error" })]),
    ).toBe("error");
    expect(
      highestSeverity([issue({ severity: "error" }), issue({ severity: "warning" })]),
    ).toBe("error");
    expect(
      highestSeverity([issue({ severity: "info" }), issue({ severity: "error" })]),
    ).toBe("error");
  });
});

describe("severityColor", () => {
  test("maps each severity (and null) to a distinct, stable color", () => {
    expect(severityColor("error")).toBe("#b00020");
    expect(severityColor("warning")).toBe("#b34700");
    expect(severityColor("info")).toBe("#0969da");
    expect(severityColor(null)).toBe("#1a192b1a");
  });
});

describe("nodeInOutCounts", () => {
  test("counts a 'step' shape's own inputFields/outputSignals", () => {
    const shape: StudioNodeShape = {
      kind: "step",
      inputFields: [
        { name: "a", type: "string", required: true, boundTo: null },
        { name: "b", type: "number", required: false, boundTo: null },
      ],
      outputSignals: [{ key: "out", type: "string", required: true }],
      resultSchemaJson: null,
    };
    expect(nodeInOutCounts(shape)).toEqual({ inCount: 2, outCount: 1 });
  });

  test("sums every branch's inputFields for a 'parallel' shape, treating null as 0", () => {
    const shape: StudioNodeShape = {
      kind: "parallel",
      branches: [
        {
          key: "a",
          label: "A",
          inputFields: [{ name: "x", type: "string", required: true, boundTo: null }],
          issues: [],
        },
        { key: "b", label: "B", inputFields: null, issues: [] },
        {
          key: "c",
          label: "C",
          inputFields: [
            { name: "y", type: "boolean", required: false, boundTo: null },
            { name: "z", type: "number", required: false, boundTo: null },
          ],
          issues: [],
        },
      ],
    };
    expect(nodeInOutCounts(shape)).toEqual({ inCount: 3, outCount: 0 });
  });

  test("returns null for a 'none' shape — no fabricated zero counts", () => {
    expect(nodeInOutCounts({ kind: "none" })).toBeNull();
  });
});

describe("formatInOutCounts", () => {
  test("formats as 'N in · M out'", () => {
    expect(formatInOutCounts({ inCount: 3, outCount: 1 })).toBe("3 in · 1 out");
    expect(formatInOutCounts({ inCount: 0, outCount: 0 })).toBe("0 in · 0 out");
  });
});
