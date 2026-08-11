import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildOpencodeTuiConfig,
  buildPipelineBuilderPackageJson,
  PIPELINE_BUILDER_TYPECHECK_SCRIPT,
  PIPELINE_BUILDER_TYPECHECK_SCRIPT_NAME,
  PIPELINE_DESIGNER_AGENT_NAME,
  PIPELINE_DESIGNER_BASH_PERMISSIONS,
  resolvePermission,
  serializeOpencodeTuiConfig,
} from "@boboddy/worker";
import {
  buildPipelineDesignerPrompt,
  DESIGN_AGENT_PROMPT,
  PIPELINE_ARCHETYPES,
  PIPELINE_AUTHORING_REFERENCE,
  PIPELINE_DESIGNER_AGENT_DESCRIPTION,
} from "../src/lib/design-agent-assets";
import { extractFencedBlocks } from "./archetype-harness";

describe("design agent assets", () => {
  test("both text assets load and are non-empty", () => {
    expect(typeof DESIGN_AGENT_PROMPT).toBe("string");
    expect(typeof PIPELINE_AUTHORING_REFERENCE).toBe("string");
    expect(DESIGN_AGENT_PROMPT.length).toBeGreaterThan(2000);
    expect(PIPELINE_AUTHORING_REFERENCE.length).toBeGreaterThan(5000);
    expect(PIPELINE_DESIGNER_AGENT_DESCRIPTION.length).toBeGreaterThan(20);
  });

  test("composed prompt concatenates the assets in order", () => {
    const prompt = buildPipelineDesignerPrompt();
    expect(prompt.startsWith(DESIGN_AGENT_PROMPT.trimEnd())).toBe(true);
    expect(prompt.indexOf("# Authoring reference")).toBeLessThan(
      prompt.indexOf("# Boboddy pipeline authoring reference"),
    );
    // The reference is no longer appended verbatim: the archetype sources are
    // spliced into its section 7, between the catalog and section 8.
    const catalog = prompt.indexOf("## 7. Archetype catalog");
    const archetypes = prompt.indexOf("### The archetype files");
    const nextSection = prompt.indexOf("## 8. Writing a good");
    expect(catalog).toBeGreaterThan(0);
    expect(archetypes).toBeGreaterThan(catalog);
    expect(nextSection).toBeGreaterThan(archetypes);
    for (const { name, source } of PIPELINE_ARCHETYPES) {
      expect(prompt).toContain(`#### \`${name}.ts\``);
      expect(prompt).toContain(source.trim());
    }
  });

  test("every fence the composed prompt opens is closed", () => {
    // The archetype sources are wrapped in three-backtick fences, so a stray
    // fence inside one would truncate the block for whatever reads the prompt.
    const fences = buildPipelineDesignerPrompt().match(/^\s*```/gm) ?? [];
    expect(fences.length % 2).toBe(0);
  });
});

/** The package managers §9 documents a `run` command for. Deno uses `check`. */
const RUN_PACKAGE_MANAGERS = ["bun", "npm", "pnpm", "yarn"] as const;

/**
 * The commands §9's *Typecheck* block tells the agent to run, one per line.
 *
 * Parsed out of the `sh` fence rather than matched with `toContain` against the
 * whole prompt: `toContain("bun run typecheck")` would still pass if the fence
 * were deleted and the string survived in some unrelated paragraph, which is
 * exactly the drift this suite exists to catch.
 */
function documentedTypecheckCommands(prompt: string): string[] {
  const from = prompt.indexOf("### Typecheck");
  const to = prompt.indexOf("### Push");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return extractFencedBlocks(prompt.slice(from, to))
    .filter((block) => block.tag === "sh")
    .flatMap((block) => block.code.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("the commands the prompt documents still behave as documented", () => {
  // The prompt and the permission block live in different packages, so nothing
  // but a test stops them drifting.
  const prompt = buildPipelineDesignerPrompt();

  test("the scaffolder really defines the script name §9 tells the agent to run", () => {
    // Without this, the assertion below would only prove the docs agree with a
    // constant — not that the constant names a script the generated
    // `package.json` actually has.
    const parsed = JSON.parse(buildPipelineBuilderPackageJson("1.2.3")) as {
      scripts: Record<string, string>;
    };
    expect(parsed.scripts[PIPELINE_BUILDER_TYPECHECK_SCRIPT_NAME]).toBe(
      PIPELINE_BUILDER_TYPECHECK_SCRIPT,
    );
  });

  test("§9 documents `<pm> run <script>` for every package manager", () => {
    const expected = RUN_PACKAGE_MANAGERS.map(
      (manager) => `${manager} run ${PIPELINE_BUILDER_TYPECHECK_SCRIPT_NAME}`,
    );
    const documented = documentedTypecheckCommands(prompt).filter((command) =>
      command.includes(" run "),
    );

    expect(documented).toEqual(expected);
  });

  test("the push command the prompt tells the agent to run still asks", () => {
    // The one command in the prompt whose permission still matters: `bash` is
    // allow-by-default, so this is the whole publish gate. `$BOBODDY_CLI` is an
    // absolute path, which is why the rule matches the `pipelines push`
    // substring rather than a command anchored on `boboddy`.
    const pushCommand = 'cd ../.. && "$BOBODDY_CLI" pipelines push';

    expect(prompt).toContain(pushCommand);
    expect(
      resolvePermission(PIPELINE_DESIGNER_BASH_PERMISSIONS, pushCommand),
    ).toBe("ask");
  });

  test("nothing else §9 documents is gated", () => {
    // The inverse of the old contract test. Under allow-by-default there are no
    // carve-outs to keep in lockstep — but a documented command that somehow
    // resolves to `ask` would still stall the session, so check the whole block.
    for (const command of documentedTypecheckCommands(prompt)) {
      expect(
        resolvePermission(PIPELINE_DESIGNER_BASH_PERMISSIONS, command),
        command,
      ).toBe("allow");
    }
  });
});

describe("composed prompt size", () => {
  // Regression guard: catches an asset silently failing to inline (far too
  // small) and unbounded growth of a prompt that ships in an env var.
  //
  // Inlining the five archetype files took this from ~26,300 to ~51,700,
  // anchoring the interview to a work item plus the change-size gate took it to
  // ~56,300, the devcontainer-authoring phase to ~59,700, the well-known
  // MCP server health check catalog (§10) to ~63,900, and project-tool
  // discovery plus the secrets/`.env.example` handling (phases 1, 3, 7, 10, and
  // AUTHORING.md §1) to ~70,900 — the lower bound is set just under the
  // current value so any further growth is a deliberate decision rather than a
  // drift.
  test("stays within the expected envelope", () => {
    const length = buildPipelineDesignerPrompt().length;
    expect(length).toBeGreaterThan(70_000);
    expect(length).toBeLessThan(74_000);
  });

  test("survives a round trip through the injected TUI config", () => {
    const prompt = buildPipelineDesignerPrompt();
    const serialized = serializeOpencodeTuiConfig(
      buildOpencodeTuiConfig({
        description: PIPELINE_DESIGNER_AGENT_DESCRIPTION,
        prompt,
      }),
    );
    const parsed = JSON.parse(serialized) as {
      agent: Record<string, { prompt: string }>;
    };
    expect(parsed.agent[PIPELINE_DESIGNER_AGENT_NAME]?.prompt).toBe(prompt);
  });
});

/**
 * The composed prompt, committed verbatim.
 *
 * Deliberately a plaintext artifact rather than `toMatchSnapshot()`. The point
 * of snapshotting a 52 KB *system prompt* is that a reviewer can read what
 * changed in the agent's instructions in the PR diff. A `.snap` file stores the
 * value as a JS template literal, which escapes every backtick and `${` — and
 * this prompt is markdown full of fenced code blocks and `${input.title}`
 * interpolations, so the stored form would be visibly unlike the shipped string
 * and noisy to read. Plaintext is byte-identical to what ships, greppable, and
 * git diffs it line by line: changing one archetype touches only that region of
 * the file, not the whole 52 KB.
 *
 * It is also the artifact nothing else provides: every other test here asserts a
 * property (size, ordering, a needle). This is the only place a reviewer sees
 * the prompt itself.
 */
const PROMPT_SNAPSHOT_PATH = join(
  import.meta.dir,
  "snapshots",
  "pipeline-designer-prompt.txt",
);

/** Set to `1` to rewrite the artifact instead of asserting against it. */
const PROMPT_SNAPSHOT_UPDATE_ENV = "UPDATE_DESIGN_AGENT_PROMPT";

function firstDifferingIndex(
  built: readonly string[],
  committed: readonly string[],
): number {
  const limit = Math.max(built.length, committed.length);
  for (let index = 0; index < limit; index += 1) {
    if (built[index] !== committed[index]) return index;
  }
  return -1;
}

/**
 * A one-line description of the drift, or `null` when the two agree.
 *
 * `expect(prompt).toBe(committed)` would dump a 52 KB diff into the terminal and
 * bury the change, so the failure is reduced to the first differing line.
 */
function describePromptDrift(built: string, committed: string): string | null {
  if (built === committed) return null;
  const builtLines = built.split("\n");
  const committedLines = committed.split("\n");
  const at = firstDifferingIndex(builtLines, committedLines);
  const show = (line: string | undefined): string =>
    JSON.stringify(line ?? "<end of file>");
  return [
    `${PROMPT_SNAPSHOT_PATH} is stale at line ${String(at + 1)}`,
    `  committed: ${show(committedLines[at])}`,
    `  built:     ${show(builtLines[at])}`,
    `(${String(committedLines.length)} committed lines vs ${String(builtLines.length)} built)`,
    `Re-run with ${PROMPT_SNAPSHOT_UPDATE_ENV}=1, then review the diff.`,
  ].join("\n");
}

describe("composed prompt snapshot", () => {
  test("matches the committed artifact", () => {
    const prompt = buildPipelineDesignerPrompt();

    if (process.env[PROMPT_SNAPSHOT_UPDATE_ENV] === "1") {
      mkdirSync(dirname(PROMPT_SNAPSHOT_PATH), { recursive: true });
      writeFileSync(PROMPT_SNAPSHOT_PATH, prompt, "utf-8");
      return;
    }

    expect(
      existsSync(PROMPT_SNAPSHOT_PATH),
      `missing artifact; re-run with ${PROMPT_SNAPSHOT_UPDATE_ENV}=1`,
    ).toBe(true);
    const committed = readFileSync(PROMPT_SNAPSHOT_PATH, "utf-8");
    expect(describePromptDrift(prompt, committed)).toBeNull();
  });
});
