import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Artifact, artifact } from "../src/definitions/artifacts";
import { findArtifactMarkers } from "../src/contracts/artifact-markers";
import { defineStep, Features } from "../src/definitions/steps";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import {
  pipelineSpec,
  pipelineStep,
  stepSpec,
} from "./definition-spec-fixtures";

const handle = { stepKey: "record", signalKey: "reproVideo" } as const;

describe("Artifact.embed / Artifact.link", () => {
  test.concurrent("builds signal markers from a handle", () => {
    expect(Artifact.embed(handle, { caption: "Repro" })).toBe(
      "![Repro](artifact:signal/record/reproVideo)",
    );
    expect(Artifact.link(handle, { label: "Trace" })).toBe(
      "[Trace](artifact:signal/record/reproVideo)",
    );
  });

  test.concurrent("builds path markers from a name or glob", () => {
    expect(Artifact.embed("shots/*.png", { caption: "Shots" })).toBe(
      "![Shots](artifact:shots/*.png)",
    );
  });

  test.concurrent("escapes captions and refs so they round-trip", () => {
    const cases = [
      { ref: "a (1).png", caption: "Look [here] \\ now" },
      { ref: "plain(1).png", caption: "x]y" },
      { ref: "dir/with <angle>.png", caption: "multi\nline" },
    ];
    for (const { ref, caption } of cases) {
      const marker = Artifact.embed(ref, { caption });
      const [found] = findArtifactMarkers(`Intro\n\n${marker}\n`);
      expect(found).toMatchObject({
        kind: "embed",
        text: caption.replace(/\s+/g, " "),
        ref: { type: "path", pattern: ref },
      });
    }
  });

  test.concurrent("works with a defined step's signal handles", () => {
    const step = defineStep({
      key: "record",
      name: "Record",
      agentPrompt: "Record it.",
      result: z.object({ reproVideo: artifact({ accept: [".mp4"] }) }),
      signals: [{ key: "reproVideo", sourcePath: "reproVideo" }],
    });
    expect(Artifact.link(step.signals.reproVideo, { label: "Video" })).toBe(
      "[Video](artifact:signal/record/reproVideo)",
    );
  });
});

describe("Features.notifications() prompt", () => {
  test.concurrent("states the marker rules", () => {
    const prompt = Features.notifications()._promptAddition;
    expect(prompt).toContain("artifact:signal/<stepKey>/<signalKey>");
    expect(prompt).toContain("artifact:<name-or-glob>");
    expect(prompt).toContain("One marker per paragraph");
    expect(prompt).toContain("Don't refer to an artifact outside its marker");
  });
});

const artifactStep = (accept: readonly string[]): StepDefinitionSpec => {
  const spec = stepSpec(
    "record",
    z.object({ reproVideo: artifact({ accept }), note: z.string() }),
    ["reproVideo", "note"],
  );
  return {
    ...spec,
    signalExtractorDefinitions: spec.signalExtractorDefinitions.map((signal) =>
      signal.key === "reproVideo"
        ? { ...signal, type: "artifact" as const }
        : signal,
    ),
  };
};

const commentStep = (prompt: string): StepDefinitionSpec => ({
  ...stepSpec("comment", null, []),
  prompt,
});

const markerIssues = (
  steps: StepDefinitionSpec[],
  nodes: string[],
): Array<{ severity: string; message: string }> =>
  validateDefinitionSpecs({
    pipelines: [
      pipelineSpec(
        "p",
        nodes.map((key, index) => pipelineStep(key, index)),
      ),
    ],
    steps,
  })
    .filter((issue) => issue.check === "artifact-marker")
    .map(({ severity, message }) => ({ severity, message }));

describe("validateDefinitionSpecs — artifact markers", () => {
  test.concurrent("accepts a marker for a step in the pipeline", () => {
    const prompt = `Post ${Artifact.embed(handle, { caption: "Repro" })}`;
    expect(
      markerIssues(
        [artifactStep([".mp4"]), commentStep(prompt)],
        ["record", "comment"],
      ),
    ).toEqual([]);
  });

  test.concurrent("rejects a marker for a step not in the pipeline", () => {
    const prompt = Artifact.embed(handle, { caption: "Repro" });
    const issues = markerIssues(
      [artifactStep([".mp4"]), commentStep(prompt)],
      ["comment"],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain(
      'step "record" is not in the pipeline',
    );
  });

  test.concurrent("rejects a marker for an undeclared signal", () => {
    const prompt = Artifact.link(
      { stepKey: "record", signalKey: "note" },
      { label: "Note" },
    );
    const issues = markerIssues(
      [artifactStep([".mp4"]), commentStep(prompt)],
      ["record", "comment"],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('no artifact signal "note"');
    expect(issues[0]?.message).toContain("reproVideo");
  });

  test.concurrent("warns when an embedded field can never be embedded", () => {
    const prompt = Artifact.embed(handle, { caption: "Repro" });
    const issues = markerIssues(
      [artifactStep([".mkv", ".zip"]), commentStep(prompt)],
      ["record", "comment"],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.message).toContain("will always be linked");
  });

  test.concurrent("does not warn for links or embeddable fields", () => {
    const steps = [
      artifactStep([".mkv"]),
      commentStep(Artifact.link(handle, { label: "Repro" })),
    ];
    expect(markerIssues(steps, ["record", "comment"])).toEqual([]);
    expect(
      markerIssues(
        [
          artifactStep([".mkv", ".mp4"]),
          commentStep(Artifact.embed(handle, { caption: "Repro" })),
        ],
        ["record", "comment"],
      ),
    ).toEqual([]);
  });

  test.concurrent(
    "ignores the placeholder markers in the notifications prompt",
    () => {
      const prompt = Features.notifications()._promptAddition;
      expect(markerIssues([commentStep(prompt)], ["comment"])).toEqual([]);
    },
  );

  test.concurrent("ignores path markers", () => {
    const prompt = Artifact.embed("shots/*.png", { caption: "Shots" });
    expect(markerIssues([commentStep(prompt)], ["comment"])).toEqual([]);
  });
});
