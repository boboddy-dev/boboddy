import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateDefinitionSpecs } from "@boboddy/sdk/definitions/validation";
import { collectDefinitionsFromDirectory } from "@boboddy/sdk/push";
import { PIPELINE_BUILDER_TSCONFIG } from "@boboddy/worker";
import {
  buildHealthCheckCatalogSection,
  buildPipelineAuthoringReference,
  DEFAULT_PIPELINE_TEMPLATE,
  HEALTH_CHECK_CATALOG,
  HEALTH_CHECK_CATALOG_EXAMPLES,
  PIPELINE_AUTHORING_REFERENCE,
} from "../src/lib/design-agent-assets";
import { expectPhrase } from "./design-agent-prompt-helpers";
import {
  extractCompilableSnippets,
  extractFencedBlocks,
  KNOWN_FENCE_TAGS,
  SHARED_STEPS_FIXTURE,
  writeHarnessTsconfig,
} from "./template-harness";

// The default pipeline and the authoring reference are TEXT assets: nothing in
// the normal typecheck looks at them, so an SDK signature change would silently
// rot the material the `pipeline-designer` agent copies from. This suite
// compiles the default pipeline plus every non-fragment snippet in
// `AUTHORING.md` against the real SDK source, in ONE `tsc` invocation, under the
// same compiler options the user's `.boboddy/pipeline-builder/` directory uses.

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_NODE_MODULES = resolve(import.meta.dir, "../node_modules");
const TSC = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const TEMPLATES_DIR = resolve(import.meta.dir, "../src/templates/design-agent");
const TEMPLATE_EXTENSION = ".ts.tmpl";
const { name, source } = DEFAULT_PIPELINE_TEMPLATE;

/** The section 7 prose, between its heading and section 8's. */
function section7(): string {
  return PIPELINE_AUTHORING_REFERENCE.slice(
    PIPELINE_AUTHORING_REFERENCE.indexOf("## 7. The default pipeline"),
    PIPELINE_AUTHORING_REFERENCE.indexOf("## 8. Writing a good"),
  );
}

describe("the default pipeline asset", () => {
  test("is a complete, non-trivial pipeline file", () => {
    expect(name).toBe("bug-pipeline");
    expect(source.length).toBeGreaterThan(1500);
    expect(source).toContain('from "@boboddy/sdk/definitions/steps"');
    expect(source).toContain('from "@boboddy/sdk/definitions/pipelines"');
    expect(source).toContain("export default definePipeline({");
    expect(source).toContain("states: {");
    expect(source).toContain('status: "active"');
    // `buildDefaultPipelineSection` wraps the source in a three-backtick fence.
    expect(source).not.toContain("```");
  });

  test("has no approval gates (D6)", () => {
    expect(source).not.toContain("blockWhen");
  });

  test("is the only template on disk, and the one the prompt inlines", () => {
    const onDisk = readdirSync(TEMPLATES_DIR)
      .filter((entry) => entry.endsWith(TEMPLATE_EXTENSION))
      .map((entry) => entry.slice(0, -TEMPLATE_EXTENSION.length));
    expect(onDisk).toEqual([name]);
  });

  test("section 7 names the file and describes it without restating code", () => {
    const prose = section7();
    expect(prose.length).toBeGreaterThan(500);
    expect(prose).toContain(`\`${name}.ts\``);
    expect(prose).not.toContain("defineStep(");
    expect(prose).not.toContain("definePipeline(");
    expect(prose).not.toContain("```");
  });

  test("is spliced in after section 7 and before section 8", () => {
    const reference = buildPipelineAuthoringReference();
    const prose = reference.indexOf("## 7. The default pipeline");
    const file = reference.indexOf(`#### \`${name}.ts\``);
    const next = reference.indexOf("## 8. Writing a good");
    expect(prose).toBeGreaterThan(-1);
    expect(file).toBeGreaterThan(prose);
    expect(next).toBeGreaterThan(file);
  });
});

describe("authoring reference fences", () => {
  const blocks = extractFencedBlocks(PIPELINE_AUTHORING_REFERENCE);

  test("every fence carries a known tag", () => {
    // Guards the compilable-vs-fragment mechanism itself: an unrecognised tag
    // (a typo like ```ts fragmnet) must fail loudly rather than quietly opt a
    // block out of compilation.
    const unknown = blocks
      .map((b) => b.tag)
      .filter((tag) => !KNOWN_FENCE_TAGS.includes(tag));
    expect(unknown).toEqual([]);
  });

  test("both fence kinds are actually in use", () => {
    expect(blocks.filter((b) => b.tag === "ts").length).toBeGreaterThan(2);
    expect(
      blocks.filter((b) => b.tag === "ts fragment").length,
    ).toBeGreaterThan(0);
  });
});

describe("the health check catalog section", () => {
  const section = buildHealthCheckCatalogSection();
  const blocks = extractFencedBlocks(section);

  test("holds both entries with every field the catalog promises", () => {
    expect(HEALTH_CHECK_CATALOG.map((entry) => entry.id)).toEqual([
      "playwright",
      "postgres",
    ]);
    for (const entry of HEALTH_CHECK_CATALOG) {
      expect(entry.label.length, entry.id).toBeGreaterThan(0);
      expect(entry.packageHint.length, entry.id).toBeGreaterThan(0);
      expect(entry.ref.length, entry.id).toBeGreaterThan(0);
      expect(entry.checkName.length, entry.id).toBeGreaterThan(0);
      expect(entry.tool.length, entry.id).toBeGreaterThan(0);
      expect(entry.caveats.length, entry.id).toBeGreaterThan(20);
    }
  });

  test("states the three origination rules and the two guidance lines", () => {
    expect(section).toContain("without\n   asking");
    expect(section).toContain(
      "only if the user supplied the\n   tool name and arguments themselves",
    );
    expect(section).toContain("Never invent a tool name or arguments");
    expect(section).toContain("No secrets in check arguments");
    expect(section).toContain("Prefer tools whose output is trivial");
  });

  test("states the per-server check severity rule and the cli checks for Playwright and the test runner", () => {
    expect(section).toContain(
      "Every server a step mounts under `mcps` gets a `tool` check",
    );
    expectPhrase(section, "Keep the server's checks `required` (the default)");
    expectPhrase(section, "set its checks to `warn` when it only helps");
    expect(section).toContain(
      "Playwright and the test runner get `cli` checks",
    );
    expect(section).toContain("--no-install");
  });

  test("every entry's label and tool appear in the rendered section", () => {
    for (const entry of HEALTH_CHECK_CATALOG) {
      expect(section).toContain(entry.label);
      expect(section).toContain(entry.tool);
      expect(section).toContain(entry.ref);
      expect(section).toContain(entry.checkName);
    }
  });

  test("every example declares its server with defineMcp, not an mcpServers + healthChecks pair", () => {
    for (const example of HEALTH_CHECK_CATALOG_EXAMPLES) {
      expect(example.source, example.id).toContain("defineMcp({");
      expect(example.source, example.id).toContain("mcps: {");
      expect(example.source, example.id).not.toContain("mcpServers");
      expect(example.source, example.id).not.toContain("healthChecks: [");
    }
  });

  test("no fenced block in the health check material is a non-compiled fragment", () => {
    expect(blocks.length).toBe(HEALTH_CHECK_CATALOG.length);
    for (const block of blocks) {
      expect(block.tag).toBe("ts");
    }
  });

  test("never invents a literal launch command from the package hint", () => {
    // Guards the catalog's core design choice (a package hint, not a literal
    // command — see `HealthCheckCatalogEntry.packageHint`'s doc comment) in
    // every place a package hint reaches: the generated section, AND the
    // default pipeline, which uses the same real package (Playwright) and
    // could just as easily reintroduce a literal there instead.
    for (const entry of HEALTH_CHECK_CATALOG) {
      const literalCommand = `"npx", "-y", "${entry.packageHint}"`;
      expect(section).not.toContain(literalCommand);
      expect(source).not.toContain(literalCommand);
    }
  });

  test("is spliced into the composed authoring reference", () => {
    const reference = buildPipelineAuthoringReference();
    expect(reference).toContain("## 10. Well-known MCP server health checks");
    expect(reference.indexOf("## 9. Validate, then push")).toBeLessThan(
      reference.indexOf("## 10. Well-known MCP server health checks"),
    );
    for (const entry of HEALTH_CHECK_CATALOG) {
      expect(reference).toContain(entry.label);
    }
  });

  test("`playwright-mcp` — the non-existent package — appears nowhere", () => {
    expect(PIPELINE_AUTHORING_REFERENCE).not.toContain("playwright-mcp");
    expect(buildPipelineAuthoringReference()).not.toContain("playwright-mcp");
    expect(source).not.toContain("playwright-mcp");
  });
});

describe("everything the agent is told to copy compiles against the SDK", () => {
  let dir = "";
  let elapsedMs = 0;
  let output = "";
  let exitCode = -1;

  beforeAll(
    () => {
      dir = mkdtempSync(join(tmpdir(), "boboddy-default-pipeline-"));

      // The SDK is reached through `paths` (see writeHarnessTsconfig) but `zod` is
      // a real resolution: Bun installs it per workspace, so borrow the CLI's.
      symlinkSync(CLI_NODE_MODULES, join(dir, "node_modules"), "dir");

      writeFileSync(join(dir, `${name}.ts`), source, "utf-8");

      // The health check catalog's rendered examples, compiled the same way as
      // the default pipeline — written directly from the exported array rather
      // than re-extracted from markdown, since that array (not the generated
      // section's markdown) is their source of truth.
      for (const example of HEALTH_CHECK_CATALOG_EXAMPLES) {
        writeFileSync(
          join(dir, `health-check-${example.id}.ts`),
          example.source,
          "utf-8",
        );
      }

      // Snippets that import `./steps` rely on the shared-steps file the
      // reference's section 0 documents. Its shape is dictated by the snippets.
      writeFileSync(join(dir, "steps.ts"), SHARED_STEPS_FIXTURE, "utf-8");

      const snippets = extractCompilableSnippets(PIPELINE_AUTHORING_REFERENCE);
      expect(snippets.length).toBeGreaterThan(2);
      snippets.forEach((snippet, index) => {
        writeFileSync(
          join(dir, `snippet-${String(index)}.ts`),
          snippet,
          "utf-8",
        );
      });

      writeHarnessTsconfig({
        dir,
        repoRoot: REPO_ROOT,
        tsconfig: PIPELINE_BUILDER_TSCONFIG,
      });

      const startedAt = Bun.nanoseconds();
      const result = Bun.spawnSync([TSC, "-p", "tsconfig.json"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      elapsedMs = (Bun.nanoseconds() - startedAt) / 1_000_000;
      output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
      exitCode = result.exitCode;
      // A cold `tsc` invocation that typechecks the real (unbuilt) SDK source
      // tree against the default pipeline, health-check examples, and
      // authoring-doc snippets routinely takes several seconds — well past
      // bun:test's default 5000ms hook timeout under CI load.
    },
    { timeout: 30_000 },
  );

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("one tsc invocation reports zero errors", () => {
    expect(output).toBe("");
    expect(exitCode).toBe(0);
  });

  test("the harness actually compiled, rather than silently doing nothing", () => {
    // A misconfigured `include` would produce an empty program and a clean
    // exit. Any real compile of the SDK source costs far more than this.
    expect(elapsedMs).toBeGreaterThan(50);
  });
});

// Compiling proves the default pipeline typechecks. It does not prove it would
// survive `boboddy pipelines push`, because the interesting failures are not
// type errors: a dead signal `sourcePath`, a binding reading a step that runs
// later or on another branch, a bound field the consumer drops. So run it
// through the same collection and the same validator a real push runs —
// `collectDefinitionsFromDirectory` takes no token and `validateDefinitionSpecs`
// makes no request, which is exactly why they were split out.
describe("the default pipeline survives the real push validator", () => {
  let dir = "";
  let collected: Awaited<ReturnType<typeof collectDefinitionsFromDirectory>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "boboddy-default-pipeline-validate-"));
    // Importing the file needs `zod` and `@boboddy/sdk` resolvable from its own
    // directory; Bun does not hoist, so borrow the CLI's.
    symlinkSync(CLI_NODE_MODULES, join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, `${name}.ts`), source, "utf-8");
    collected = await collectDefinitionsFromDirectory(dir);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("collection finds the pipeline and its five steps", () => {
    // Guards against a vacuous pass: an empty batch validates clean.
    expect(collected.pipelines.map((pipeline) => pipeline.key)).toEqual([
      "bug-pipeline",
    ]);
    expect(collected.steps.map((step) => step.key).sort()).toEqual([
      "evaluate",
      "failing-test",
      "fix",
      "investigate-and-reproduce",
      "request-details",
    ]);
  });

  test("`quality` is the only signal besides the notifications feature's (D7)", () => {
    const signalKeys = collected.steps
      .flatMap((step) => step.signalExtractorDefinitions)
      .map((signal) => signal.key)
      .filter((key) => key !== "$boboddy_notifications_v1");
    expect(signalKeys).toEqual(["quality"]);
  });

  test("demonstrates the health-check rules: a tool check per ref, cli checks for Playwright and the test runner", () => {
    const checksByStep = Object.fromEntries(
      collected.steps.map((step) => [
        step.key,
        (step.healthChecksJson ?? []).map((check) =>
          check.kind === "cli"
            ? `cli:${check.command.join(" ")}:${check.severity ?? "required"}`
            : `tool:${check.name ?? ""}=${check.mcp ?? ""}/${check.tool}:${check.severity ?? "required"}`,
        ),
      ]),
    );
    expect(checksByStep).toEqual({
      evaluate: [],
      "request-details": [],
      "investigate-and-reproduce": [
        "tool:playwright.navigate=playwright/browser_navigate:required",
        "cli:npx --no-install playwright --version:warn",
      ],
      "failing-test": ["cli:npx --no-install vitest --version:required"],
      fix: ["cli:npx --no-install vitest --version:required"],
    });
  });

  test("the defineMcp server compiles to a plain required ref", () => {
    const investigate = collected.steps.find(
      (step) => step.key === "investigate-and-reproduce",
    );
    expect(investigate?.opencodeMcpJson).toEqual({
      playwright: { type: "ref" },
    });
    expect(source).toContain("defineMcp({");
    expect(source).not.toContain("mcpServers");
  });

  test("every server a step refs has a tool check targeting it", () => {
    for (const step of collected.steps) {
      const checked = new Set(
        (step.healthChecksJson ?? []).flatMap((check) =>
          check.kind !== "cli" && check.mcp ? [check.mcp] : [],
        ),
      );
      for (const key of Object.keys(step.opencodeMcpJson ?? {})) {
        expect(checked.has(key), `${step.key} → ${key}`).toBe(true);
      }
    }
  });

  test("the validator reports no issues at any severity", () => {
    const issues = validateDefinitionSpecs(collected);
    expect(issues.map((issue) => issue.message)).toEqual([]);
  });

  test("the binding check is live: a forward binding is rejected", () => {
    // If this passed, the clean result above would prove nothing about
    // whether the template's `ctx.output(...)` bindings are actually checked.
    const [pipeline] = collected.pipelines;
    if (!pipeline) throw new Error("no pipeline collected");
    const broken = {
      ...pipeline,
      nodeDefinitions: pipeline.nodeDefinitions.map((node) =>
        node.nodeKey === "investigateAndReproduce" &&
        "inputBindingsJson" in node
          ? {
              ...node,
              inputBindingsJson: {
                ...node.inputBindingsJson,
                failingTest: {
                  source: "step_output" as const,
                  stepKey: "failingTest",
                },
              },
            }
          : node,
      ),
    };
    const issues = validateDefinitionSpecs({
      pipelines: [broken],
      steps: collected.steps,
    });
    expect(issues.some((issue) => issue.check === "signal-binding")).toBe(true);
  });
});
