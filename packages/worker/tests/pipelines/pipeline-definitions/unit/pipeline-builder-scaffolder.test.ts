import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldPipelineBuilderDirectory,
  STARTER_PIPELINE_FILENAME,
} from "../../../../src/pipelines/pipeline-definitions/infra/pipeline-builder-scaffolder";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-builder-test-"));
}

describe("scaffoldPipelineBuilderDirectory", () => {
  describe("fresh directory", () => {
    test("creates package.json, tsconfig.json, .gitignore, starter pipeline, and default assignment", () => {
      const dir = makeTempDir();
      try {
        const result = scaffoldPipelineBuilderDirectory(dir, "0.0.0");

        expect(result.created).toContain("package.json");
        expect(result.created).toContain("tsconfig.json");
        expect(result.created).toContain(".gitignore");
        expect(result.created).toContain(STARTER_PIPELINE_FILENAME);
        expect(result.created).toContain("default-pipeline-assignment.ts");
        expect(result.skipped).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("all files exist on disk after scaffold", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");

        expect(existsSync(join(dir, "package.json"))).toBe(true);
        expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
        expect(existsSync(join(dir, ".gitignore"))).toBe(true);
        expect(existsSync(join(dir, STARTER_PIPELINE_FILENAME))).toBe(true);
        expect(existsSync(join(dir, "default-pipeline-assignment.ts"))).toBe(
          true,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("does not create steps or pipelines subdirectories", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");

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
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(join(dir, ".gitignore"), "utf-8");
        expect(content.trim()).toBe("*");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("package.json contains @boboddy/sdk and zod dependencies", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(join(dir, "package.json"), "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const deps = parsed["dependencies"] as Record<string, unknown>;
        expect(deps).toHaveProperty("@boboddy/sdk");
        expect(deps).toHaveProperty("zod");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("package.json uses caret range for @boboddy/sdk when version is stable", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "1.2.3");
        const content = readFileSync(join(dir, "package.json"), "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const deps = parsed["dependencies"] as Record<string, unknown>;
        expect(deps["@boboddy/sdk"]).toBe("^1.2.3");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("package.json pins @boboddy/sdk exactly when version is a prerelease", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(
          dir,
          "0.0.0-canary.7b958a970f3965d4f76c51ae393dad11f712a919",
        );
        const content = readFileSync(join(dir, "package.json"), "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const deps = parsed["dependencies"] as Record<string, unknown>;
        // Must be exact — no caret — so npm does not resolve to a different
        // prerelease that may be missing features added in this release.
        expect(deps["@boboddy/sdk"]).toBe(
          "0.0.0-canary.7b958a970f3965d4f76c51ae393dad11f712a919",
        );
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
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
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
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
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

    test("starter pipeline defines two steps wired into one pipeline", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(
          join(dir, STARTER_PIPELINE_FILENAME),
          "utf-8",
        );
        const defineStepCount = (content.match(/defineStep\(\{/g) ?? [])
          .length;
        // real .step() calls reference a step variable; comments say ".step()"
        const stepCallCount = (content.match(/\.step\(\w/g) ?? []).length;
        expect(defineStepCount).toBe(2);
        expect(stepCallCount).toBe(2);
        expect(content).toContain("pipeline(");
        expect(content).toContain(".build()");
        expect(content).toContain("export default");
        expect(content).toContain("additionalInput:");
        expect(content).toContain("result:");
        expect(content).toContain("agentPrompt:");
        expect(content).toContain("z.object");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("starter pipeline demonstrates a signal-gated advancement with a block default", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(
          join(dir, STARTER_PIPELINE_FILENAME),
          "utf-8",
        );
        expect(content).toContain(".advance(");
        expect(content).toContain('signal("confidence")');
        expect(content).toContain(".gte(7)");
        expect(content).toContain('.then("continue")');
        expect(content).toContain('default: "block"');
        // every step must have an .advance() call; real calls take a callback
        const advanceCount = (content.match(/\.advance\(\(/g) ?? []).length;
        expect(advanceCount).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("starter pipeline steps run in no_workspace mode so the quickstart needs no devcontainer", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(
          join(dir, STARTER_PIPELINE_FILENAME),
          "utf-8",
        );
        const noWorkspaceCount = (
          content.match(/executionMode: "no_workspace"/g) ?? []
        ).length;
        expect(noWorkspaceCount).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("default assignment file assigns the starter pipeline by default", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(
          join(dir, "default-pipeline-assignment.ts"),
          "utf-8",
        );
        expect(content).toContain("defaultPipelineAssignment(");
        expect(content).toContain('from "./triage-and-plan"');
        expect(content).toContain("default: assign(");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("idempotency", () => {
    test("skips files that already exist on a second run", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const second = scaffoldPipelineBuilderDirectory(dir, "0.0.0");

        expect(second.created).toEqual([]);
        expect(second.skipped).toContain("package.json");
        expect(second.skipped).toContain("tsconfig.json");
        expect(second.skipped).toContain(".gitignore");
        expect(second.skipped).toContain(STARTER_PIPELINE_FILENAME);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("creates missing files without touching existing ones", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        rmSync(join(dir, STARTER_PIPELINE_FILENAME));

        const second = scaffoldPipelineBuilderDirectory(dir, "0.0.0");

        expect(second.created).toEqual([STARTER_PIPELINE_FILENAME]);
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
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        expect(existsSync(dir)).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });
});
