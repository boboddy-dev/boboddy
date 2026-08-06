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
  PIPELINE_ARCHETYPES,
  PIPELINE_AUTHORING_REFERENCE,
} from "../src/lib/design-agent-assets";
import {
  extractCompilableSnippets,
  extractFencedBlocks,
  KNOWN_FENCE_TAGS,
  SHARED_STEPS_FIXTURE,
  writeHarnessTsconfig,
} from "./archetype-harness";

// The archetypes and the authoring reference are TEXT assets: nothing in the
// normal typecheck looks at them, so an SDK signature change would silently rot
// the material the `pipeline-designer` agent copies from. This suite compiles
// every archetype plus every non-fragment snippet in `AUTHORING.md` against the
// real SDK source, in ONE `tsc` invocation, under the same compiler options the
// user's `.boboddy/pipeline-builder/` directory uses.

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_NODE_MODULES = resolve(import.meta.dir, "../node_modules");
const TSC = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const ARCHETYPES_DIR = resolve(
  import.meta.dir,
  "../src/templates/design-agent/archetypes",
);
const ARCHETYPE_EXTENSION = ".ts.tmpl";

describe("archetype assets", () => {
  test("all five archetypes are present and non-trivial", () => {
    expect(PIPELINE_ARCHETYPES.map((a) => a.name)).toEqual([
      "browser-repro",
      "failing-test-repro",
      "data-investigation",
      "intake-triage",
      "router",
    ]);
    for (const { name, source } of PIPELINE_ARCHETYPES) {
      expect(source.length, name).toBeGreaterThan(1500);
      // Complete files, not fragments.
      expect(source, name).toContain('from "@boboddy/sdk/definitions/steps"');
      expect(source, name).toContain(
        'from "@boboddy/sdk/definitions/pipelines"',
      );
      expect(source, name).toContain("export default pipeline({");
      expect(source, name).toContain(".build();");
      expect(source, name).toContain('status: "active"');
      // `buildArchetypeSection` wraps each source in a three-backtick fence.
      expect(source, name).not.toContain("```");
    }
  });

  test("the archetype catalog references every archetype by filename", () => {
    for (const { name, heading } of PIPELINE_ARCHETYPES) {
      expect(PIPELINE_AUTHORING_REFERENCE).toContain(`\`${name}.ts\``);
      expect(PIPELINE_AUTHORING_REFERENCE).toContain(heading);
    }
  });

  test("the catalog states shapes but no longer restates archetype code", () => {
    // A2's goal: one copy of every line of code. The catalog prose must not
    // grow a second copy of a `defineStep` or `pipeline()` call.
    const catalog = PIPELINE_AUTHORING_REFERENCE.slice(
      PIPELINE_AUTHORING_REFERENCE.indexOf("## 7. Archetype catalog"),
      PIPELINE_AUTHORING_REFERENCE.indexOf("## 8. Writing a good"),
    );
    expect(catalog.length).toBeGreaterThan(500);
    expect(catalog).not.toContain("defineStep(");
    expect(catalog).not.toContain("pipeline(");
    expect(catalog).not.toContain("```");
  });
});

/** Filename stems of the archetype templates actually on disk. */
function archetypeStemsOnDisk(): string[] {
  return readdirSync(ARCHETYPES_DIR)
    .filter((entry) => entry.endsWith(ARCHETYPE_EXTENSION))
    .map((entry) => entry.slice(0, -ARCHETYPE_EXTENSION.length))
    .sort();
}

/** A markdown table's rows, split into trimmed cells, separators dropped. */
function parseMarkdownTable(section: string): string[][] {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/u.test(cell)));
}

/** Filename stems named by the `File` column of the section 7 table. */
function archetypeStemsInCatalogTable(): string[] {
  const rows = parseMarkdownTable(
    PIPELINE_AUTHORING_REFERENCE.slice(
      PIPELINE_AUTHORING_REFERENCE.indexOf("## 7. Archetype catalog"),
      PIPELINE_AUTHORING_REFERENCE.indexOf("## 8. Writing a good"),
    ),
  );
  const [header, ...body] = rows;
  const column = header?.indexOf("File") ?? -1;
  if (!header || column === -1) {
    throw new Error(
      "Section 7 of AUTHORING.md no longer has a table with a `File` column, " +
        "so the agent has no index of the archetype files to copy from.",
    );
  }
  return body
    .map((cells) => {
      const cell = cells[column] ?? "";
      const stem = /^`(.+)\.ts`$/u.exec(cell)?.[1];
      if (stem === undefined) {
        throw new Error(
          `Section 7's File column has an unparseable cell: ${JSON.stringify(cell)}`,
        );
      }
      return stem;
    })
    .sort();
}

describe("the archetype files and the docs index agree", () => {
  // Two failure modes no single-sided check can see: an ORPHAN `.ts.tmpl` that
  // nothing tells the agent about, and a DANGLING docs row naming a file that
  // is not there. Note an orphan would not appear in `PIPELINE_ARCHETYPES`
  // either, so comparing that constant against the docs would miss it — hence
  // one side is enumerated from disk and the other parsed out of the table.

  test("the section 7 table lists every archetype file, and no others", () => {
    const onDisk = archetypeStemsOnDisk();
    expect(onDisk.length).toBeGreaterThan(0);
    expect(archetypeStemsInCatalogTable()).toEqual(onDisk);
  });

  test("every archetype file on disk is inlined into the prompt", () => {
    // The third orphan class: a file the docs advertise and that exists, but
    // which `design-agent-assets.ts` never imports, so the agent never sees it.
    expect([...PIPELINE_ARCHETYPES].map(({ name }) => name).sort()).toEqual(
      archetypeStemsOnDisk(),
    );
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

describe("everything the agent is told to copy compiles against the SDK", () => {
  let dir = "";
  let elapsedMs = 0;
  let output = "";
  let exitCode = -1;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "boboddy-archetypes-"));

    // The SDK is reached through `paths` (see writeHarnessTsconfig) but `zod` is
    // a real resolution: Bun installs it per workspace, so borrow the CLI's.
    symlinkSync(CLI_NODE_MODULES, join(dir, "node_modules"), "dir");

    for (const { name, source } of PIPELINE_ARCHETYPES) {
      writeFileSync(join(dir, `${name}.ts`), source, "utf-8");
    }

    // Snippets that import `./steps` rely on the shared-steps file the
    // reference's section 0 documents. Its shape is dictated by the snippets.
    writeFileSync(join(dir, "steps.ts"), SHARED_STEPS_FIXTURE, "utf-8");

    const snippets = extractCompilableSnippets(PIPELINE_AUTHORING_REFERENCE);
    expect(snippets.length).toBeGreaterThan(2);
    snippets.forEach((snippet, index) => {
      writeFileSync(join(dir, `snippet-${String(index)}.ts`), snippet, "utf-8");
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
  });

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

// Compiling proves the archetypes typecheck. It does not prove they would
// survive `boboddy pipelines push`, because the interesting failures are not
// type errors: a dead signal `sourcePath`, a route to a pipeline nobody
// defines, a binding reading a step that runs later. So run the archetypes
// through the same collection and the same validator a real push runs —
// `collectDefinitionsFromDirectory` takes no token and `validateDefinitionSpecs`
// makes no request, which is exactly why they were split out.
describe("every archetype survives the real push validator", () => {
  let dir = "";
  let collected: Awaited<ReturnType<typeof collectDefinitionsFromDirectory>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "boboddy-archetype-validate-"));
    // Importing the archetypes needs `zod` and `@boboddy/sdk` resolvable from
    // their own directory; Bun does not hoist, so borrow the CLI's.
    symlinkSync(CLI_NODE_MODULES, join(dir, "node_modules"), "dir");

    // Only the archetypes: the router's route targets are the OTHER
    // archetypes' pipeline keys, so the whole catalog has to be pushed as one
    // batch for those routes to resolve. That is a real property of the
    // material the agent copies, and this is what asserts it.
    for (const { name, source } of PIPELINE_ARCHETYPES) {
      writeFileSync(join(dir, `${name}.ts`), source, "utf-8");
    }

    collected = await collectDefinitionsFromDirectory(dir);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("collection finds one pipeline per archetype, with signals to check", () => {
    // Guards against a vacuous pass: an empty batch validates clean.
    expect(collected.pipelines).toHaveLength(PIPELINE_ARCHETYPES.length);
    expect(collected.steps.length).toBeGreaterThanOrEqual(
      PIPELINE_ARCHETYPES.length,
    );
    const signalCount = collected.steps.reduce(
      (total, step) => total + step.signalExtractorDefinitions.length,
      0,
    );
    expect(signalCount).toBeGreaterThan(20);
  });

  test("the validator reports no issues for the catalog as one batch", () => {
    const issues = validateDefinitionSpecs(collected);
    expect(issues.map((issue) => issue.message)).toEqual([]);
  });

  test("the route check is live: the router alone cannot resolve its targets", () => {
    // Same batch minus the pipelines the router routes to. If this passed, the
    // clean result above would prove nothing about route validation.
    const router = collected.pipelines.filter(
      (pipeline) => pipeline.key === "work-item-router",
    );
    expect(router).toHaveLength(1);
    const issues = validateDefinitionSpecs({
      pipelines: router,
      steps: collected.steps,
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.check === "route-target")).toBe(true);
  });
});
