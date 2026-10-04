import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { codeStep } from "../src/definitions/steps/define-code-step";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import {
  findCodeStepInModule,
  stepsInModule,
} from "../src/push/code-step-lookup";
import {
  PIPELINE_BUILDER_DIR,
  collectDefinitionsFromDirectory,
} from "../src/push/collect-definitions";

function pipelineWith(steps: StepDefinitionSpec[]) {
  return {
    key: "pipeline",
    name: "Pipeline",
    description: null,
    version: 1,
    status: "active",
    entryNodeKey: "done",
    nodeDefinitions: [{ nodeKey: "done", kind: "succeed" }],
    dependencyEdges: [],
    _stepDefinitions: steps,
  };
}

function userDefinedStep(key: string): StepDefinitionSpec {
  return {
    key,
    name: key,
    description: null,
    version: 1,
    kind: "user_defined",
    status: "active",
    prompt: "hello",
    inputSchemaJson: null,
    resultSchemaJson: null,
    signalExtractorDefinitions: [],
    opencodeMcpJson: null,
    opencodePluginJson: null,
    healthChecksJson: null,
  };
}

describe("findCodeStepInModule", () => {
  test("finds a code step exported by name", () => {
    const fn = () => 1;
    const step = codeStep({ key: "exported", name: "Exported", fn });

    expect(findCodeStepInModule({ step }, "exported")).toBe(fn);
  });

  test("finds a code step that exists only inside the default pipeline", () => {
    const fn = () => 2;
    const step = codeStep({ key: "embedded", name: "Embedded", fn });

    expect(
      findCodeStepInModule({ default: pipelineWith([step]) }, "embedded"),
    ).toBe(fn);
  });

  test("returns undefined for an unknown key", () => {
    const step = codeStep({ key: "exported", name: "Exported", fn: () => 1 });

    expect(findCodeStepInModule({ step }, "other")).toBeUndefined();
  });

  test("ignores non-code steps with a matching key", () => {
    const mod = { step: userDefinedStep("same-key") };

    expect(findCodeStepInModule(mod, "same-key")).toBeUndefined();
  });

  test("ignores a code spec without a function at entrypoint.fn", () => {
    const step = codeStep({ key: "no-fn", name: "No fn", fn: () => 1 });
    const stripped: StepDefinitionSpec = { ...step };
    delete stripped.entrypoint;

    expect(findCodeStepInModule({ step: stripped }, "no-fn")).toBeUndefined();
  });

  test("throws when two distinct fns are registered under one key", () => {
    const first = codeStep({ key: "dup", name: "Dup", fn: () => 1 });
    const second = codeStep({ key: "dup", name: "Dup", fn: () => 2 });

    expect(() => findCodeStepInModule({ first, second }, "dup")).toThrow(
      /"dup" is ambiguous/,
    );
    expect(() =>
      findCodeStepInModule({ first, default: pipelineWith([second]) }, "dup"),
    ).toThrow(/"dup" is ambiguous/);
  });

  test("does not throw when the same fn is exported and embedded", () => {
    const fn = () => 1;
    const exported = codeStep({ key: "both", name: "Both", fn });
    const embedded = codeStep({ key: "both", name: "Both", fn });

    expect(
      findCodeStepInModule(
        { step: exported, default: pipelineWith([embedded]) },
        "both",
      ),
    ).toBe(fn);
  });
});

describe("stepsInModule", () => {
  test("dedupes a step reachable by export and by embedding", () => {
    const step = codeStep({ key: "once", name: "Once", fn: () => 1 });
    const alias = step;

    expect(
      stepsInModule({ step, alias, default: pipelineWith([step]) }),
    ).toEqual([step]);
  });

  test("takes embedded steps only from a pipeline default export", () => {
    const step = codeStep({ key: "embedded", name: "Embedded", fn: () => 1 });

    expect(stepsInModule({ default: { notAPipeline: true } })).toEqual([]);
    expect(stepsInModule({ pipeline: pipelineWith([step]) })).toEqual([]);
  });
});

describe("collector parity", () => {
  test("every collected code step is found by findCodeStepInModule in its sourceFile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boboddy-code-step-lookup-test-"));
    const stepModule = join(
      import.meta.dir,
      "../src/definitions/steps/define-code-step",
    );
    const importSpecifier = relative(dir, stepModule);
    const header = `import { codeStep } from "${importSpecifier}";\n`;

    try {
      writeFileSync(
        join(dir, "exported.ts"),
        `${header}
export function helper(input) { return input; }
export const byReference = codeStep({ key: "by-reference", name: "By reference", fn: helper });
export const inlineArrow = codeStep({ key: "inline-arrow", name: "Inline arrow", fn: (input) => input });
`,
      );
      writeFileSync(
        join(dir, "pipeline.ts"),
        `${header}
const shared = codeStep({ key: "shared", name: "Shared", fn: () => "shared" });
export { shared };
export default {
  key: "pipeline",
  name: "Pipeline",
  description: null,
  version: 1,
  status: "active",
  entryNodeKey: "done",
  nodeDefinitions: [{ nodeKey: "done", kind: "succeed" }],
  dependencyEdges: [],
  _stepDefinitions: [
    shared,
    codeStep({ key: "embedded-only", name: "Embedded only", fn: () => "embedded" }),
  ],
};
`,
      );

      const collected = await collectDefinitionsFromDirectory(dir);
      const codeSteps = collected.steps.filter((s) => s.kind === "code");
      expect(codeSteps.map((s) => s.key).sort()).toEqual([
        "by-reference",
        "embedded-only",
        "inline-arrow",
        "shared",
      ]);

      for (const step of codeSteps) {
        const sourceFile = step.entrypointJson?.sourceFile ?? "";
        expect(sourceFile).not.toBe("");
        const absolute = join(dir, relative(PIPELINE_BUILDER_DIR, sourceFile));
        const mod = (await import(pathToFileURL(absolute).href)) as Record<
          string,
          unknown
        >;
        expect(typeof findCodeStepInModule(mod, step.key)).toBe("function");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
