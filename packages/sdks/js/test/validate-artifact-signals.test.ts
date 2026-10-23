import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { artifact } from "../src/definitions/artifacts";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpec } from "./definition-spec-fixtures";

function artifactStep(
  result: z.ZodType | null,
  sourcePaths: readonly string[],
): StepDefinitionSpec {
  const spec = stepSpec("s", result, sourcePaths);
  return {
    ...spec,
    signalExtractorDefinitions: spec.signalExtractorDefinitions.map(
      (signal) => ({ ...signal, type: "artifact" as const }),
    ),
  };
}

function artifactIssues(step: StepDefinitionSpec): string[] {
  return validateDefinitionSpecs({ pipelines: [], steps: [step] })
    .filter(
      (issue) =>
        issue.check === "artifact-signal" || issue.check === "artifact-field",
    )
    .map((issue) => issue.message);
}

const RESULT = z.object({
  reproVideo: artifact({ accept: [".mp4"] }),
  trace: artifact().nullable().optional(),
  nested: z.object({ shot: artifact() }),
  summary: z.string(),
});

describe("validateDefinitionSpecs — artifact signals", () => {
  test.concurrent("accepts signals on artifact fields", () => {
    expect(
      artifactIssues(
        artifactStep(RESULT, ["reproVideo", "trace", "nested.shot"]),
      ),
    ).toEqual([]);
  });

  test.concurrent("rejects an artifact signal on a non-artifact field", () => {
    const issues = artifactIssues(artifactStep(RESULT, ["summary"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('artifact signal "summary"');
    expect(issues[0]).toContain("not an artifact field");
    expect(issues[0]).toContain("reproVideo, trace, nested.shot");
  });

  test.concurrent("rejects an artifact signal on a step with no result", () => {
    const issues = artifactIssues(artifactStep(null, ["video"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("no result schema");
  });

  test.concurrent("rejects a path the schema is too loose to resolve", () => {
    const issues = artifactIssues(
      artifactStep(z.object({ bag: z.record(z.string(), z.unknown()) }), [
        "bag.video",
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("too loose");
    expect(issues[0]).toContain("declares no artifact fields");
  });

  test.concurrent("leaves an unresolvable path to signal-source-path", () => {
    const step = artifactStep(RESULT, ["missing"]);
    expect(artifactIssues(step)).toEqual([]);
    expect(
      validateDefinitionSpecs({ pipelines: [], steps: [step] }).map(
        (issue) => issue.check,
      ),
    ).toEqual(["signal-source-path"]);
  });

  test.concurrent("rejects a signal on an array of artifacts", () => {
    const issues = artifactIssues(
      artifactStep(z.object({ shots: z.array(artifact()) }), [
        "shots",
        "shots[0]",
      ]),
    );
    const forSignal = (key: string): string[] =>
      issues.filter((m) => m.includes(`artifact signal "${key}"`));
    expect(forSignal("shots")).toHaveLength(1);
    expect(forSignal("shots")[0]).toContain("not an artifact field");
    expect(forSignal("shots[0]")).toHaveLength(1);
    expect(forSignal("shots[0]")[0]).toContain("indexes into an array");
  });

  test.concurrent("ignores signals of other types", () => {
    expect(
      artifactIssues(stepSpec("s", RESULT, ["reproVideo", "summary"])),
    ).toEqual([]);
  });
});

describe("validateDefinitionSpecs — artifact fields", () => {
  test.concurrent("rejects artifact fields inside arrays", () => {
    const issues = artifactIssues(
      stepSpec(
        "s",
        z.object({
          shots: z.array(artifact()),
          runs: z.array(z.object({ video: artifact() })),
          ok: artifact(),
        }),
        [],
      ),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('artifact field "shots[]" inside an array');
    expect(issues[1]).toContain(
      'artifact field "runs[].video" inside an array',
    );
  });
});
