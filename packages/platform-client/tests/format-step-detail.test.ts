import { describe, expect, test } from "bun:test";
import {
  formatStepArtifacts,
  formatStepDetail,
  MAX_JSON_RENDER_CHARS,
} from "../src/format-step-detail";
import {
  makeArtifact,
  makeStepDefinition,
  makeStepExecution,
  makeStepRun,
} from "./fixtures";

describe("formatStepDetail", () => {
  test("reports a step that has not been reached yet", () => {
    const output = formatStepDetail({
      stepItem: {
        stepKey: "fix",
        position: 2,
        definition: makeStepDefinition({ key: "fix", name: "Fix" }),
        stepRun: null,
        runs: [],
      },
      stepExecution: null,
    });

    expect(output).toContain("Step: fix (Fix)");
    expect(output).toContain("Status: not reached yet in this attempt");
  });

  test("renders status, satisfaction, timestamps, work branch, signals, output, and evaluation", () => {
    const stepRun = makeStepRun({
      status: "unsatisfied",
      satisfactionStatus: "unsatisfied_by_policy",
      workBranch: "boboddy/investigate-1",
      outputJson: { finding: "root cause found" },
      evaluation: {
        id: "eval-1",
        decisionKind: "step_policy",
        finalStatus: "fail",
        finalAction: "block",
        finalPayloadJson: { reason: "needs human review" },
        createdAt: "2026-01-01T00:05:00.000Z",
      },
    });
    const stepExecution = makeStepExecution({
      result: {
        id: "result-1",
        status: "succeeded",
        resultJson: {},
        errorJson: null,
        signals: [
          {
            id: "signal-1",
            key: "risk_level",
            type: "string",
            source: "extracted",
            valueJson: "high",
            sourcePath: "$.risk",
          },
        ],
      },
    });

    const output = formatStepDetail({
      stepItem: {
        stepKey: "investigate",
        position: 1,
        definition: makeStepDefinition(),
        stepRun,
        runs: [stepRun],
      },
      stepExecution,
    });

    expect(output).toContain("Status: ✗ unsatisfied   Satisfaction: unsatisfied_by_policy");
    expect(output).toContain("Work branch: boboddy/investigate-1");
    expect(output).toContain(`Started:   ${String(stepExecution.startedAt)}`);
    expect(output).toContain(`Completed: ${String(stepExecution.completedAt)}`);
    expect(output).toContain("risk_level (string, extracted)");
    expect(output).toContain('"high"');
    expect(output).toContain('"finding": "root cause found"');
    expect(output).toContain("Decision: step_policy   Final status: fail   Final action: block");
    expect(output).toContain('"reason": "needs human review"');
  });

  test("truncates output JSON past the render cap with an explicit notice", () => {
    const bigValue = "x".repeat(MAX_JSON_RENDER_CHARS + 500);
    const stepRun = makeStepRun({ outputJson: { blob: bigValue } });

    const output = formatStepDetail({
      stepItem: {
        stepKey: "investigate",
        position: 1,
        definition: makeStepDefinition(),
        stepRun,
        runs: [stepRun],
      },
      stepExecution: makeStepExecution(),
    });

    expect(output).toContain("[truncated,");
    expect(output.length).toBeLessThan(bigValue.length + 1_000);
  });

  test("notes when a step has no step execution yet", () => {
    const stepRun = makeStepRun({ stepExecutionId: null, status: "queued" });
    const output = formatStepDetail({
      stepItem: {
        stepKey: "investigate",
        position: 1,
        definition: makeStepDefinition(),
        stepRun,
        runs: [stepRun],
      },
      stepExecution: null,
    });

    expect(output).toContain("(no step execution yet)");
    expect(output).toContain("Started:   —");
  });
});

describe("formatStepArtifacts", () => {
  test("lists artifacts with their download URL", () => {
    const output = formatStepArtifacts("investigate", [
      {
        artifact: makeArtifact({ relativeStorePath: "trace.zip", sizeBytes: 2048 }),
        downloadUrl: "https://storage.example.test/trace.zip",
        note: null,
      },
    ]);

    expect(output).toContain("Artifacts for step investigate:");
    expect(output).toContain("trace.zip (2048 bytes)");
    expect(output).toContain("https://storage.example.test/trace.zip");
  });

  test("reports an expired artifact instead of a raw URL", () => {
    const output = formatStepArtifacts("investigate", [
      {
        artifact: makeArtifact(),
        downloadUrl: null,
        note: "expired",
      },
    ]);

    expect(output).toContain("(unavailable: expired)");
  });

  test("reports no artifacts", () => {
    const output = formatStepArtifacts("investigate", []);
    expect(output).toContain("(none)");
  });
});
