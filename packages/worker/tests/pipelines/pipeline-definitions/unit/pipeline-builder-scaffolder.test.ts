import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PIPELINE_BUILDER_TYPECHECK_SCRIPT,
  scaffoldPipelineBuilderDirectory,
  STARTER_PIPELINE_FILENAME,
} from "../../../../src/pipelines/pipeline-definitions/infra/pipeline-builder-scaffolder";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-builder-test-"));
}

/** Strip comments and blank lines, leaving the actual ignore patterns. */
function parseIgnoreRules(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Does any rule ignore `path` (relative to the .gitignore's own directory)?
 *
 * A deliberately minimal stand-in for git's matcher, valid only because every
 * generated rule is a literal path — the ".gitignore uses only literal,
 * non-glob rules" test above enforces that precondition.
 */
function ignoresPath(rules: string[], path: string): boolean {
  const segments = path.split("/");
  return rules.some((rule) => {
    // A leading slash anchors the rule to the .gitignore's directory.
    if (rule.startsWith("/")) return path === rule.slice(1);
    // A trailing slash means "directory named X, at any depth".
    if (rule.endsWith("/")) {
      const name = rule.slice(0, -1);
      return segments.includes(name);
    }
    // Otherwise: a bare name matching at any depth.
    return segments.at(-1) === rule;
  });
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
    test(".gitignore ignores only generated and vendored artifacts", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(join(dir, ".gitignore"), "utf-8");

        const rules = parseIgnoreRules(content);

        expect(rules).toEqual([
          "node_modules/",
          "/bun.lock",
          "/bun.lockb",
          "/package-lock.json",
          "/pnpm-lock.yaml",
          "/yarn.lock",
          "/deno.lock",
          "/push.ts",
          "/work-item-fields.ts",
          "/.run-offer-gate-failure.json",
        ]);

        // Every rule is a literal path — no `*`, `?`, `[]`, or `!` negation.
        // That precondition is what lets `ignoresPath` compare names directly
        // instead of reimplementing git's glob semantics.
        for (const rule of rules) {
          expect(rule).not.toMatch(/[*?[\]!]/);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(".gitignore does not ignore pipeline definitions or project config", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const rules = parseIgnoreRules(
          readFileSync(join(dir, ".gitignore"), "utf-8"),
        );

        // The files a teammate needs on a fresh clone must stay committable.
        for (const committable of [
          STARTER_PIPELINE_FILENAME,
          "default-pipeline-assignment.ts",
          "steps.ts",
          "my-custom-pipeline.ts",
          "package.json",
          "tsconfig.json",
          ".gitignore",
        ]) {
          expect(ignoresPath(rules, committable)).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(".gitignore ignores node_modules, lockfiles, and the push script", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const rules = parseIgnoreRules(
          readFileSync(join(dir, ".gitignore"), "utf-8"),
        );

        for (const ignored of [
          "node_modules",
          "node_modules/@boboddy/sdk/package.json",
          "bun.lock",
          "bun.lockb",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "deno.lock",
          "push.ts",
        ]) {
          expect(ignoresPath(rules, ignored)).toBe(true);
        }
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

    test("package.json exposes a typecheck script backed by typescript", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(join(dir, "package.json"), "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const scripts = parsed["scripts"] as Record<string, unknown>;
        const devDeps = parsed["devDependencies"] as Record<string, unknown>;
        // The designer agent's bash allowlist matches `<pm> run typecheck`
        // exactly, so this script has to exist for the carve-out to mean
        // anything.
        expect(scripts["typecheck"]).toBe(PIPELINE_BUILDER_TYPECHECK_SCRIPT);
        expect(devDeps).toHaveProperty("typescript");
        expect(devDeps).toHaveProperty("tsx");
      } finally {
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

    test("tsconfig.json makes a fresh scaffold typecheck clean", () => {
      // Each of these exists to keep `tsc -p tsconfig.json` silent out of the
      // box; a noisy baseline teaches everyone (human and agent) to ignore it.
      // Verified empirically against a real install: without skipLibCheck AND
      // without DOM, the SDK's client types fail on `fetch`/`Response`; with
      // push.ts included, it fails on `import.meta.dirname`.
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(join(dir, "tsconfig.json"), "utf-8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const compilerOptions = parsed["compilerOptions"] as Record<
          string,
          unknown
        >;
        expect(compilerOptions["skipLibCheck"]).toBe(true);
        expect(compilerOptions["noEmit"]).toBe(true);
        expect(compilerOptions["lib"]).toEqual(["ES2022", "DOM"]);
        expect(parsed["exclude"]).toEqual(["node_modules", "push.ts"]);
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
        // real `kind: "step"` states reference a step variable; comments say "step"
        const stepStateCount = (content.match(/kind: "step",/g) ?? []).length;
        expect(defineStepCount).toBe(2);
        expect(stepStateCount).toBe(2);
        expect(content).toContain("definePipeline(");
        expect(content).toContain("startAt:");
        expect(content).toContain("states:");
        expect(content).toContain("export default");
        expect(content).toContain("additionalInput:");
        expect(content).toContain("result:");
        expect(content).toContain("agentPrompt:");
        expect(content).toContain("z.object");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("starter pipeline demonstrates a signal-gated blockWhen and a succeed exit", () => {
      const dir = makeTempDir();
      try {
        scaffoldPipelineBuilderDirectory(dir, "0.0.0");
        const content = readFileSync(
          join(dir, STARTER_PIPELINE_FILENAME),
          "utf-8",
        );
        expect(content).toContain("blockWhen:");
        expect(content).toContain('Rule.when("confidence", "lessThan", 7)');
        expect(content).toContain('kind: "succeed"');
        // every `step` state must declare where it goes next
        const nextCount = (content.match(/next: "/g) ?? []).length;
        expect(nextCount).toBe(2);
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
