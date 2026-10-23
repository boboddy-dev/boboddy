import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Artifact,
  artifact,
  type ArtifactPath,
} from "../src/definitions/artifacts";
import { codeStep } from "../src/definitions/steps/define-code-step";
import {
  defineStep,
  inferSignalType,
} from "../src/definitions/steps/define-step";

const RESULT = z.object({
  reproVideo: artifact({ accept: [".mp4"] }),
  trace: artifact().nullable(),
  nested: z.object({ shot: artifact({ accept: [".png"] }) }),
  summary: z.string(),
  count: z.number(),
});

describe("inferSignalType", () => {
  const json = z.toJSONSchema(RESULT) as Record<string, unknown>;

  test.concurrent(
    "infers artifact for direct, nullable and nested fields",
    () => {
      expect(inferSignalType(RESULT, json, "reproVideo")).toBe("artifact");
      expect(inferSignalType(RESULT, json, "trace")).toBe("artifact");
      expect(inferSignalType(RESULT, json, "nested.shot")).toBe("artifact");
    },
  );

  test.concurrent("falls back to the Zod type for other fields", () => {
    expect(inferSignalType(RESULT, json, "summary")).toBe("string");
    expect(inferSignalType(RESULT, json, "count")).toBe("number");
    expect(inferSignalType(RESULT, json, "nested")).toBe("object");
  });

  test.concurrent("returns undefined with no schema to go on", () => {
    expect(inferSignalType(undefined, null, "anything")).toBeUndefined();
  });
});

describe("defineStep with artifact fields", () => {
  const step = defineStep({
    key: "repro",
    name: "Repro",
    agentPrompt: "Reproduce it.",
    result: RESULT,
    signals: [
      { sourcePath: "reproVideo" },
      { key: "traceFile", sourcePath: "trace" },
      { sourcePath: "summary" },
    ],
  });

  test.concurrent("writes the inferred artifact type on the signal", () => {
    expect(
      step.signalExtractorDefinitions.map(({ key, type }) => ({ key, type })),
    ).toEqual([
      { key: "reproVideo", type: "artifact" },
      { key: "traceFile", type: "artifact" },
      { key: "summary", type: "string" },
    ]);
  });

  test.concurrent("exposes typed signal handles", () => {
    expect(step.signals.reproVideo).toEqual({
      stepKey: "repro",
      signalKey: "reproVideo",
    });
    expect(step.signals.traceFile.signalKey).toBe("traceFile");
    const value: ArtifactPath | undefined = step.signals.reproVideo.__value;
    expect(value).toBeUndefined();
  });

  test.concurrent("keeps handles out of the serialised spec", () => {
    expect(Object.keys(step)).not.toContain("signals");
    expect(JSON.parse(JSON.stringify(step))).not.toHaveProperty("signals");
    expect({ ...step }).not.toHaveProperty("signals");
    expect(Object.isFrozen(step.signals)).toBe(true);
  });

  test.concurrent("keeps an explicit type over the inferred one", () => {
    const explicit = defineStep({
      key: "explicit",
      name: "Explicit",
      agentPrompt: "x",
      result: RESULT,
      signals: [{ sourcePath: "summary", type: "artifact" }],
    });
    expect(explicit.signalExtractorDefinitions[0]?.type).toBe("artifact");
  });
});

describe("codeStep signal handles", () => {
  test.concurrent("attaches handles for declared signals", () => {
    const step = codeStep({
      key: "record",
      name: "Record",
      fn: () => ({ video: Artifact.path("out.mp4") }),
      resultSchema: z.object({ video: artifact() }),
      signals: [{ sourcePath: "video", type: "artifact" }],
    });
    expect(step.signals.video).toEqual({
      stepKey: "record",
      signalKey: "video",
    });
    expect(Object.keys(step)).not.toContain("signals");
  });
});
