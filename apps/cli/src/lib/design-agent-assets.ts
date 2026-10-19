// Knowledge assets for the `pipeline-designer` primary agent injected into the
// OpenCode TUI by `boboddy pipelines design`.
//
// Every asset is inlined at build time via Bun's `with { type: "text" }` import
// attribute, so the `bun build --compile` binary carries them as strings —
// nothing is read from disk at runtime.
//
// They are concatenated into ONE prompt string rather than written into the
// user's `.boboddy/pipeline-builder/` directory. OpenCode's `{file:…}` prompt
// templating resolves relative to the process cwd, which is the user's
// directory, so the file-reference approach would mean littering their repo
// with a prompt file. Inline keeps the user's directory clean and makes the
// prompt atomic with the config that carries it.
//
// The default pipeline is the scaffolder's starter pipeline
// (`STARTER_PIPELINE_FILE` in `@boboddy/worker`), so the file the agent is
// told about is byte-for-byte the file already sitting in the user's
// directory. `test/design-agent-default-pipeline.test.ts` compiles it against
// the real SDK in one `tsc` pass, so SDK drift fails the build instead of
// silently rotting the agent's reference material.
import agentPrompt from "../templates/design-agent/AGENT_PROMPT.md" with { type: "text" };
import authoringReference from "../templates/design-agent/AUTHORING.md" with { type: "text" };
import { STARTER_PIPELINE_FILE, STARTER_PIPELINE_KEY } from "@boboddy/worker";
import {
  HEALTH_CHECK_CATALOG,
  type HealthCheckCatalogEntry,
} from "../templates/design-agent/health-check-catalog";

export { HEALTH_CHECK_CATALOG, type HealthCheckCatalogEntry };

/** The designer's role, interview procedure, and behavioural rules. */
export const DESIGN_AGENT_PROMPT: string = agentPrompt;

/**
 * The SDK cheatsheet, invariant catalog, default pipeline guidance, prompt-
 * writing guidance, and validation workflow.
 */
export const PIPELINE_AUTHORING_REFERENCE: string = authoringReference;

/** The one complete, compile-verified pipeline file the agent adapts in place. */
export const DEFAULT_PIPELINE_TEMPLATE: {
  /** Filename stem it is scaffolded under, as named in section 7. */
  readonly name: string;
  /** Verbatim file contents. */
  readonly source: string;
} = { name: STARTER_PIPELINE_KEY, source: STARTER_PIPELINE_FILE };

/** Shown in the OpenCode agent picker. */
export const PIPELINE_DESIGNER_AGENT_DESCRIPTION =
  "Interviews you about your work items and execution environment, then " +
  "authors and pushes Boboddy pipeline definitions.";

/**
 * Where the default pipeline source is spliced into the authoring reference:
 * the start of the section that follows section 7, which describes it.
 *
 * It is injected rather than written into `AUTHORING.md` so there is exactly
 * one copy of it in the repo — the scaffolder's `.ts.tmpl` file, which the
 * default pipeline test compiles. Splicing (rather than appending at the end) keeps the file
 * next to the prose that explains how to adapt it.
 */
const DEFAULT_PIPELINE_SPLICE_MARKER = "\n## 8. Writing a good `agentPrompt`";

const DEFAULT_PIPELINE_SECTION_PREAMBLE = `### The default pipeline file

The block below is a complete file that compiles against the shipped SDK. The
scaffold already wrote it, verbatim, to
\`.boboddy/pipeline-builder/bug-pipeline.ts\`. Edit that file in place as
described above: configure \`investigateAndReproduce\` for what the agent can
reach, and rewrite every prompt for this user's repository and vocabulary.
Never author the state objects from scratch, and never leave its prompts
unrewritten — prompt text is where a pipeline's quality lives, and these are
written for a generic project.`;

/**
 * Render the default pipeline as one markdown block.
 *
 * Fenced with three backticks, which is safe because the template contains no
 * fence of its own — asserted in `test/design-agent-default-pipeline.test.ts`.
 */
function buildDefaultPipelineSection(): string {
  const { name, source } = DEFAULT_PIPELINE_TEMPLATE;
  return [
    DEFAULT_PIPELINE_SECTION_PREAMBLE,
    `#### \`${name}.ts\`\n\n\`\`\`ts\n${source.trim()}\n\`\`\``,
  ].join("\n\n");
}

/** The authoring reference with the default pipeline spliced into section 7. */
export function buildPipelineAuthoringReference(): string {
  const reference = PIPELINE_AUTHORING_REFERENCE.trim();
  const at = reference.indexOf(DEFAULT_PIPELINE_SPLICE_MARKER);
  if (at === -1) {
    throw new Error(
      `AUTHORING.md no longer contains ${JSON.stringify(DEFAULT_PIPELINE_SPLICE_MARKER)}, ` +
        "so the default pipeline has nowhere to go. Update DEFAULT_PIPELINE_SPLICE_MARKER.",
    );
  }
  return [
    reference.slice(0, at).trimEnd(),
    buildDefaultPipelineSection(),
    reference.slice(at).trim(),
    buildHealthCheckCatalogSection(),
  ].join("\n\n");
}

/**
 * Origination rules for health checks, appended to the authoring reference as
 * section 10.
 *
 * Constrains ORIGIN, not content, because the designer cannot verify anything
 * it writes: it has no MCP servers of its own, no enforced typecheck, and push
 * validates shape only. A fabricated tool *name* is cheap to detect — the
 * runner fails on it in milliseconds — but a guessed *argument set* on a
 * *real* tool would run automatically forever with nothing to catch it.
 */
const HEALTH_CHECK_RULES = `1. Add a catalogued server's health check to its \`defineMcp\` **without
   asking** — every call below is safe by construction (it navigates to a
   blank page or lists schema names), so there is nothing to confirm.
2. Add a health check for any other tool **only if the user supplied the
   tool name and arguments themselves.**
3. **Never invent a tool name or arguments.** A fabricated tool name is cheap
   to catch — the runner fails on it in milliseconds. A guessed argument set
   on a real tool is not: it runs automatically, at \`required\` severity by
   default, with nothing to catch it.
4. **Every server a step mounts under \`mcps\` gets a \`tool\` check** calling
   the tool the user chose for it, defined once in its \`defineMcp\`. Keep the
   server's checks \`required\` (the default) when the step cannot do its job
   without it, and set its checks to \`warn\` when it only helps. A missing
   env var the server needs fails the step either way, unless it is listed in
   \`optionalEnv\`.
5. **Playwright and the test runner get \`cli\` checks** in the step's own
   \`healthChecks\` — a command that proves the binary is installed without
   doing any work, such as
   \`["npx", "--no-install", "playwright", "--version"]\`. \`--no-install\` stops
   \`npx\` downloading what the environment lacks, which is the thing being
   checked. The test runner's check is \`required\` on a step that writes or
   runs tests; the Playwright CLI's is \`warn\` when the browser is driven
   through its MCP server.`;

const HEALTH_CHECK_GUIDANCE = `- **No secrets in check arguments.** There is no interpolation mechanism, and
  the values are persisted in the database, returned by the API, and rendered
  in the UI. A secret belongs in the server's definition (the repository's,
  or an inline \`local\`/\`remote\` \`defineMcp\`'s \`environment\`/\`headers\`),
  referenced as \`{env:VAR}\` (or in \`defineMcp\`'s \`env\` when the server
  reads \`process.env\` itself), with the variable name recorded in
  \`.boboddy/.env.example\` per §1's "Secrets" note.
- **Prefer tools whose output is trivial.** Health check output is logged in
  full.`;

/**
 * A markdown table listing every catalog entry, generated from
 * {@link HEALTH_CHECK_CATALOG} rather than hand-authored, so it cannot drift
 * from the data the examples below are rendered from.
 */
function buildHealthCheckCatalogTable(): string {
  const header = "| Server | Package hint | `ref` | Check | Tool |";
  const separator = "| --- | --- | --- | --- | --- |";
  const rows = HEALTH_CHECK_CATALOG.map(
    ({ label, packageHint, ref, checkName, tool }) =>
      `| ${label} | \`${packageHint}\` | \`${ref}\` | \`${checkName}\` | \`${tool}\` |`,
  );
  return [header, separator, ...rows].join("\n");
}

/**
 * A complete, compilable step file demonstrating one catalog entry as a
 * `defineMcp` with its health check, mounted on a step under `mcps`.
 *
 * The server itself is a `ref` to the repository's own definition, so the
 * example never builds a launch command from `packageHint` — writing one would
 * be exactly the literal the catalog exists to avoid (see
 * `HealthCheckCatalogEntry.packageHint`'s doc comment).
 */
export function buildHealthCheckExampleSource(
  entry: HealthCheckCatalogEntry,
): string {
  const stepKey = `${entry.id}-health-check-example`;
  const varName = `${entry.id}HealthCheckExample`;
  const argsLiteral = JSON.stringify(entry.args);
  return `import { z } from "zod";
import { defineMcp, defineStep } from "@boboddy/sdk/definitions/steps";

// The repository's "${entry.ref}" server launches "${entry.packageHint}". See
// the caveats above for what its definition needs.
const ${entry.ref} = defineMcp({
  type: "ref",
  name: "${entry.ref}",
  healthChecks: {
    ${entry.checkName}: { tool: "${entry.tool}", args: ${argsLiteral} },
  },
});

export const ${varName} = defineStep({
  key: "${stepKey}",
  name: "${entry.label}",
  status: "active",
  agentPrompt: "Use the ${entry.ref} MCP tools.",
  mcps: { ${entry.ref} },
  result: z.object({ ok: z.boolean() }),
  signals: [{ sourcePath: "ok" }],
});
`;
}

type HealthCheckCatalogExample = {
  readonly entry: HealthCheckCatalogEntry;
  readonly source: string;
};

/**
 * One rendered example per catalog entry, computed once so the markdown
 * section and the compile harness both read the same pairing instead of
 * zipping two separately-derived arrays back together by index.
 */
const HEALTH_CHECK_CATALOG_RENDERED: readonly HealthCheckCatalogExample[] =
  HEALTH_CHECK_CATALOG.map((entry) => ({
    entry,
    source: buildHealthCheckExampleSource(entry),
  }));

/**
 * Rendered examples, one per catalog entry, in catalog order.
 *
 * Exported so `test/design-agent-default-pipeline.test.ts` can compile each
 * one against the real SDK through the same harness the default pipeline uses,
 * the same way `DEFAULT_PIPELINE_TEMPLATE` is compiled directly rather than
 * re-extracted from markdown.
 */
export const HEALTH_CHECK_CATALOG_EXAMPLES: readonly {
  readonly id: string;
  readonly source: string;
}[] = HEALTH_CHECK_CATALOG_RENDERED.map(({ entry, source }) => ({
  id: entry.id,
  source,
}));

function buildHealthCheckExampleBlock({
  entry,
  source,
}: HealthCheckCatalogExample): string {
  return `#### ${entry.label}\n\n${entry.caveats}\n\n\`\`\`ts\n${source.trim()}\n\`\`\``;
}

/**
 * Render {@link HEALTH_CHECK_CATALOG} as the authoring reference's final
 * section: the origination rules, the two guidance lines, a table of every
 * entry, then one compilable example per entry.
 *
 * Entirely generated — unlike section 7's prose, which stays hand-authored in
 * `AUTHORING.md` — because every fact here (rules, guidance, and the table) is
 * either fixed policy or catalog data, so generating all of it keeps this
 * section's only source of truth {@link HEALTH_CHECK_CATALOG}.
 */
export function buildHealthCheckCatalogSection(): string {
  return [
    "## 10. Well-known MCP server health checks",
    "A health check runs a real tool call against a step's launched " +
      "environment before the agent starts working. Never ask the user about " +
      "this feature; just apply the rules below.",
    HEALTH_CHECK_RULES,
    HEALTH_CHECK_GUIDANCE,
    "If a step mounts one of these servers, its `defineMcp` carries the row's " +
      "health check:",
    buildHealthCheckCatalogTable(),
    "### The catalog examples",
    HEALTH_CHECK_CATALOG_RENDERED.map(buildHealthCheckExampleBlock).join(
      "\n\n",
    ),
  ].join("\n\n");
}

/**
 * Compose the full system prompt for the designer agent.
 *
 * `AGENT_PROMPT.md` deliberately ends with an `# Authoring reference` heading,
 * so the reference is appended as that section's body.
 */
export function buildPipelineDesignerPrompt(): string {
  return `${DESIGN_AGENT_PROMPT.trimEnd()}\n\n${buildPipelineAuthoringReference()}\n`;
}
