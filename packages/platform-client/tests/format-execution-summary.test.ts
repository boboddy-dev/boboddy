import { describe, expect, test } from "bun:test";
import { formatExecutionSummary } from "../src/format-execution-summary";
import { buildExecutionStepItems } from "../src/lib/execution-step-items";
import {
  makeAttempt,
  makeExecution,
  makePipelineDefinition,
  makeStepDefinition,
  makeStepRun,
  makeWorkItem,
} from "./fixtures";

describe("formatExecutionSummary", () => {
  test("renders execution status, attempt info, and one line per step", () => {
    const pipelineDefinition = makePipelineDefinition({
      stepDefinitions: [
        makeStepDefinition({ key: "investigate", name: "Investigate", position: 1 }),
        makeStepDefinition({ key: "fix", name: "Fix", position: 2 }),
      ],
    });
    const attempt = makeAttempt({
      stepRuns: [
        makeStepRun({ stepKey: "investigate", status: "satisfied" }),
      ],
    });
    const execution = makeExecution({ attempts: [attempt] });
    const workItem = makeWorkItem();
    const stepItems = buildExecutionStepItems(
      pipelineDefinition.stepDefinitions,
      attempt.stepRuns,
    );

    const output = formatExecutionSummary({
      execution,
      workItem,
      pipelineDefinition,
      attempt,
      stepItems,
    });

    expect(output).toContain(`Pipeline execution ${execution.id}`);
    expect(output).toContain("Work item: Fix the flaky test");
    expect(output).toContain("Pipeline: Bug Triage (bug-triage)");
    expect(output).toContain("Status: running");
    expect(output).toContain("Attempt 1 — running");
    expect(output).toContain("Current step: investigate");
    expect(output).toContain("✓ investigate  Investigate  satisfied");
    expect(output).toContain("○ fix  Fix  (not reached)");
    expect(output).toContain("--step <key>");
    expect(output).toContain("--log");
    expect(output).toContain("--artifacts");
  });

  test("hints at --attempt when a non-latest attempt is shown", () => {
    const pipelineDefinition = makePipelineDefinition();
    const oldAttempt = makeAttempt({ attemptNumber: 1, status: "failed" });
    const latestAttempt = makeAttempt({ attemptNumber: 2, status: "running" });
    const execution = makeExecution({
      attempts: [oldAttempt, latestAttempt],
    });
    const stepItems = buildExecutionStepItems(
      pipelineDefinition.stepDefinitions,
      oldAttempt.stepRuns,
    );

    const output = formatExecutionSummary({
      execution,
      workItem: makeWorkItem(),
      pipelineDefinition,
      attempt: oldAttempt,
      stepItems,
    });

    expect(output).toContain("this is attempt 1; latest is 2");
  });

  test("omits the work item URL when absent", () => {
    const pipelineDefinition = makePipelineDefinition();
    const attempt = makeAttempt();
    const execution = makeExecution({ attempts: [attempt] });
    const workItem = makeWorkItem({ url: null });
    const stepItems = buildExecutionStepItems(
      pipelineDefinition.stepDefinitions,
      attempt.stepRuns,
    );

    const output = formatExecutionSummary({
      execution,
      workItem,
      pipelineDefinition,
      attempt,
      stepItems,
    });

    expect(output).toContain("Work item: Fix the flaky test\n");
    expect(output).not.toContain("(https://");
  });
});
