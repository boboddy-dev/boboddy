import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  collectDefinitionsFromDirectory,
  collectDefinitionsFromDirectoryTolerant,
} from "../src/push/collect-definitions";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "boboddy-collect-defs-test-"));
}

// Absolute path to `define-code-step.ts`, computed from this test file's own
// location rather than `process.cwd()` (which is the SDK package root when
// running `bun test`, not necessarily a stable anchor for a fixture written
// into an arbitrary temp directory).
const CODE_STEP_MODULE_PATH = join(
  import.meta.dir,
  "../src/definitions/steps/define-code-step",
);

function codeStepImportSpecifier(fromDir: string): string {
  const rel = relative(fromDir, CODE_STEP_MODULE_PATH);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

describe("collectDefinitionsFromDirectory — code steps", () => {
  test("resolves a code step's entrypoint to {sourceFile, exportName} and strips fn", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "review-file-step.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export function doReview(input) {
  return { ok: true };
}

export const reviewFileStep = codeStep({
  key: "review-file",
  name: "Review File",
  fn: doReview,
});
`,
      );

      const collected = await collectDefinitionsFromDirectory(dir);
      const step = collected.steps.find((s) => s.key === "review-file");

      expect(step).toBeDefined();
      expect(step?.kind).toBe("code");
      expect(step?.entrypoint).toBeUndefined();
      expect(step?.entrypointJson?.exportName).toBe("doReview");
      expect(step?.entrypointJson?.sourceFile).toBe(
        relative(process.cwd(), join(dir, "review-file-step.ts")),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws a clear error when a code step's fn is not a named export", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "bad-step.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export const badStep = codeStep({
  key: "bad-step",
  name: "Bad Step",
  fn: (input) => input,
});
`,
      );

      let caught: unknown;
      try {
        await collectDefinitionsFromDirectory(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/is not a named export/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectDefinitionsFromDirectoryTolerant", () => {
  test("isolates one broken file — every other file's pipeline still collects", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "good-pipeline.ts"),
        `export default {
  key: "good-pipeline",
  name: "Good Pipeline",
  description: null,
  version: 1,
  status: "active",
  nodeDefinitions: [{ nodeKey: "done", kind: "succeed" }],
  dependencyEdges: [],
};
`,
      );
      writeFileSync(
        join(dir, "bad-pipeline.ts"),
        `throw new Error('state "a" targets unknown state "b"');\n`,
      );

      const collected = await collectDefinitionsFromDirectoryTolerant(dir);

      expect(collected.pipelines).toHaveLength(1);
      expect(collected.pipelines[0]?.key).toBe("good-pipeline");
      expect(collected.brokenPipelines).toHaveLength(1);
      expect(collected.brokenPipelines[0]).toMatchObject({
        key: "bad-pipeline",
        message: 'state "a" targets unknown state "b"',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unresolvable embedded code step marks its owning pipeline broken by key, not by filename", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "review-file-pipeline.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export default {
  key: "review-file-pipeline",
  name: "Review File Pipeline",
  description: null,
  version: 1,
  status: "active",
  nodeDefinitions: [{ nodeKey: "done", kind: "succeed" }],
  dependencyEdges: [],
  _stepDefinitions: [
    codeStep({ key: "bad-step", name: "Bad Step", fn: (input) => input }),
  ],
};
`,
      );

      const collected = await collectDefinitionsFromDirectoryTolerant(dir);

      expect(collected.pipelines).toHaveLength(0);
      expect(collected.brokenPipelines).toHaveLength(1);
      expect(collected.brokenPipelines[0]?.key).toBe("review-file-pipeline");
      expect(collected.brokenPipelines[0]?.message).toMatch(/is not exported by name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty directory collects cleanly with no broken pipelines", async () => {
    const dir = makeTempDir();
    try {
      const collected = await collectDefinitionsFromDirectoryTolerant(dir);
      expect(collected).toMatchObject({
        pipelines: [],
        brokenPipelines: [],
        defaultPipelineAssignment: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
