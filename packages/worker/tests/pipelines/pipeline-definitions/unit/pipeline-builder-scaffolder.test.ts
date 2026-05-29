import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldPipelineBuilderDirectory,
  type StepInfo,
} from "../../../../src/pipelines/pipeline-definitions/infra/pipeline-builder-scaffolder";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-builder-test-"));
}

const EXAMPLE_STEP: StepInfo = {
  key: "investigate",
  name: "Investigate",
  version: 1,
  prompt:
    "You are an expert investigator. Analyze the provided content thoroughly to identify the root cause, assess the severity, and recommend next steps.",
  signals: [{ key: "confidence", sourcePath: "confidence", type: "number" }],
};

describe("scaffoldPipelineBuilderDirectory", () => {
  describe("fresh directory", () => {
    test("creates package.json, tsconfig.json, .gitignore, and example-pipeline.ts", () => {
      const dir = makeTempDir();
      try {
        const result = scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");

        expect(result.created).toContain("package.json");
        expect(result.created).toContain("tsconfig.json");
        expect(result.created).toContain(".gitignore");
        expect(result.created).toContain("example-pipeline.ts");
        expect(result.skipped).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("all files exist on disk after scaffold", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");

        expect(existsSync(join(dir, "package.json"))).toBe(true);
        expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
        expect(existsSync(join(dir, ".gitignore"))).toBe(true);
        expect(existsSync(join(dir, "example-pipeline.ts"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("does not create steps or pipelines subdirectories", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [], "0.0.0");

        expect(existsSync(join(dir, "steps"))).toBe(false);
        expect(existsSync(join(dir, "pipelines"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("file contents", () => {
    test(".gitignore contains a wildcard to ignore everything", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [], "0.0.0");
        const content = readFileSync(join(dir, ".gitignore"), "utf-8");
        expect(content.trim()).toBe("*");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("package.json contains @boboddy/sdk and zod dependencies", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [], "0.0.0");
        const content = readFileSync(join(dir, "package.json"), "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const deps = parsed["dependencies"] as Record<string, unknown>;
        expect(deps).toHaveProperty("@boboddy/sdk");
        expect(deps).toHaveProperty("zod");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("package.json uses artifact path for @boboddy/sdk when BOBODDY_SDK_ARTIFACT_PATH is set", () => {
      const dir = makeTempDir();
      const previous = process.env["BOBODDY_SDK_ARTIFACT_PATH"];
      const fakeArtifact = "/tmp/boboddy-sdk-local-12345.tgz";
      process.env["BOBODDY_SDK_ARTIFACT_PATH"] = fakeArtifact;
      try {
        scaffoldPipelineBuilderDirectory(dir, [], "0.0.0");
        const content = readFileSync(join(dir, "package.json"), "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const deps = parsed["dependencies"] as Record<string, unknown>;
        expect(deps["@boboddy/sdk"]).toBe(`file:${fakeArtifact}`);
      } finally {
        if (previous === undefined) {
          delete process.env["BOBODDY_SDK_ARTIFACT_PATH"];
        } else {
          process.env["BOBODDY_SDK_ARTIFACT_PATH"] = previous;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("tsconfig.json is self-contained with essential compiler options", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [], "0.0.0");
        const content = readFileSync(join(dir, "tsconfig.json"), "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        expect(parsed["extends"]).toBeUndefined();
        const compilerOptions = parsed["compilerOptions"] as Record<
          string,
          unknown
        >;
        expect(compilerOptions["strict"]).toBe(true);
        expect(compilerOptions["moduleResolution"]).toBe("Bundler");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("example-pipeline.ts contains step key, name, version, signals, input, and result", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");
        const content = readFileSync(join(dir, "example-pipeline.ts"), "utf-8");
        expect(content).toContain("defineStep");
        expect(content).toContain("investigate");
        expect(content).toContain("Investigate");
        expect(content).toContain("confidence");
        expect(content).toContain("prompt:");
        expect(content).toContain("input:");
        expect(content).toContain("result:");
        expect(content).toContain("z.object");
        expect(content).toContain("export default");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("example-pipeline.ts defines both the step and the pipeline in one file", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");
        const content = readFileSync(join(dir, "example-pipeline.ts"), "utf-8");
        expect(content).toContain("defineStep");
        expect(content).toContain("pipeline(");
        expect(content).toContain(".build()");
        expect(content).toContain("investigate");
        expect(content).toContain("investigation");
        expect(content).toContain("export default");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("example-pipeline.ts includes a fluent advancement rule for step with signals", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");
        const content = readFileSync(join(dir, "example-pipeline.ts"), "utf-8");
        expect(content).toContain(".advance(");
        expect(content).toContain('signal("confidence")');
        expect(content).toContain(".gte(1)");
        expect(content).toContain('.then("continue")');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("example-pipeline.ts with no steps emits a placeholder step", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [], "0.0.0");
        const content = readFileSync(join(dir, "example-pipeline.ts"), "utf-8");
        expect(content).toContain("pipeline(");
        expect(content).toContain(".build()");
        expect(content).toContain(".step(");
        expect(content).toContain(".advance(");
        expect(content).toContain("placeholder");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("multiple steps are all defined and referenced in example-pipeline.ts", () => {
      const dir = makeTempDir();
      const steps: StepInfo[] = [
        {
          key: "step-one",
          name: "Step One",
          version: 1,
          signals: [{ key: "score", sourcePath: "score", type: "number" }],
        },
        {
          key: "step-two",
          name: "Step Two",
          version: 2,
          signals: [],
        },
      ];
      try {
        scaffoldPipelineBuilderDirectory(dir, steps, "0.0.0");

        const content = readFileSync(join(dir, "example-pipeline.ts"), "utf-8");
        expect(content).toContain("stepOne");
        expect(content).toContain("stepTwo");
        // every step must have an .advance() call
        const advanceCount = (content.match(/\.advance\(/g) ?? []).length;
        expect(advanceCount).toBe(steps.length);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("step without signals gets a default:continue advance call", () => {
      const dir = makeTempDir();
      const steps: StepInfo[] = [
        {
          key: "no-signal-step",
          name: "No Signal Step",
          version: 1,
          signals: [],
        },
      ];
      try {
        scaffoldPipelineBuilderDirectory(dir, steps, "0.0.0");
        const content = readFileSync(join(dir, "example-pipeline.ts"), "utf-8");
        expect(content).toContain(".advance(");
        expect(content).toContain('"continue"');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("idempotency", () => {
    test("skips files that already exist on a second run", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");
        const second = scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");

        expect(second.created).toEqual([]);
        expect(second.skipped).toContain("package.json");
        expect(second.skipped).toContain("tsconfig.json");
        expect(second.skipped).toContain(".gitignore");
        expect(second.skipped).toContain("example-pipeline.ts");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("creates missing files without touching existing ones", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");
        rmSync(join(dir, "example-pipeline.ts"));

        const second = scaffoldPipelineBuilderDirectory(dir, [EXAMPLE_STEP], "0.0.0");

        expect(second.created).toEqual(["example-pipeline.ts"]);
        expect(second.skipped).toContain("package.json");
        expect(second.skipped).toContain("tsconfig.json");
        expect(second.skipped).toContain(".gitignore");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("directory creation", () => {
    test("creates nested target directory if it does not exist", () => {
      const parent = makeTempDir();
      const dir = join(parent, "nested", "pipeline-builder");
      try {
        scaffoldPipelineBuilderDirectory(dir, [], "0.0.0");
        expect(existsSync(dir)).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });
});
