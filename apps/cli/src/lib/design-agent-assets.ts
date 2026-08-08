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
// The archetypes use the `.ts.tmpl` extension rather than `.ts` deliberately.
// `apps/cli/tsconfig.json` includes `src/**/*.ts`, so a `.ts` file here would be
// typechecked — but TypeScript then resolves the import path as a module and
// rejects a string default export, making `with { type: "text" }` impossible.
// The source of truth therefore stays a text asset, and
// `test/design-agent-archetypes.test.ts` compiles all of them against the real
// SDK in one `tsc` pass, so SDK drift fails the build instead of silently
// rotting the agent's reference material.
import agentPrompt from "../templates/design-agent/AGENT_PROMPT.md" with { type: "text" };
import authoringReference from "../templates/design-agent/AUTHORING.md" with { type: "text" };
import browserRepro from "../templates/design-agent/archetypes/browser-repro.ts.tmpl" with { type: "text" };
import dataInvestigation from "../templates/design-agent/archetypes/data-investigation.ts.tmpl" with { type: "text" };
import failingTestRepro from "../templates/design-agent/archetypes/failing-test-repro.ts.tmpl" with { type: "text" };
import intakeTriage from "../templates/design-agent/archetypes/intake-triage.ts.tmpl" with { type: "text" };
import router from "../templates/design-agent/archetypes/router.ts.tmpl" with { type: "text" };
import {
  HEALTH_CHECK_CATALOG,
  type HealthCheckCatalogEntry,
} from "../templates/design-agent/health-check-catalog";

export { HEALTH_CHECK_CATALOG, type HealthCheckCatalogEntry };

/** The designer's role, interview procedure, and behavioural rules. */
export const DESIGN_AGENT_PROMPT: string = agentPrompt;

/**
 * The SDK cheatsheet, invariant catalog, archetype selection guidance, prompt-
 * writing guidance, and validation workflow.
 */
export const PIPELINE_AUTHORING_REFERENCE: string = authoringReference;

/** One complete, compile-verified pipeline file the agent copies and adapts. */
export type PipelineArchetype = {
  /** Filename stem, matching the `File` column of the section 7 table. */
  readonly name: string;
  /** The `A.`–`E.` catalog entry it implements. */
  readonly heading: string;
  /** Verbatim file contents. */
  readonly source: string;
};

/**
 * Ordered to match section 7's `A.`–`E.` catalog, so the agent reads them in
 * the order it was told to choose between them.
 */
export const PIPELINE_ARCHETYPES: readonly PipelineArchetype[] = [
  {
    name: "browser-repro",
    heading: "A. Browser / deployed-app reproduction",
    source: browserRepro,
  },
  {
    name: "failing-test-repro",
    heading: "B. Code-level failing-test reproduction",
    source: failingTestRepro,
  },
  {
    name: "data-investigation",
    heading: "C. Read-only data / state investigation",
    source: dataInvestigation,
  },
  {
    name: "intake-triage",
    heading: "D. Triage / intake quality scoring",
    source: intakeTriage,
  },
  { name: "router", heading: "E. Router → other pipelines", source: router },
];

/** Shown in the OpenCode agent picker. */
export const PIPELINE_DESIGNER_AGENT_DESCRIPTION =
  "Interviews you about your work items and execution environment, then " +
  "authors and pushes Boboddy pipeline definitions.";

/**
 * Where the archetype sources are spliced into the authoring reference: the
 * start of the section that follows the archetype catalog.
 *
 * They are injected rather than written into `AUTHORING.md` so there is exactly
 * one copy of each archetype in the repo — the `.ts.tmpl` file, which the
 * archetype test compiles. Splicing (rather than appending at the end) keeps
 * each file next to the catalog entry that tells the agent when to pick it.
 */
const ARCHETYPE_SPLICE_MARKER = "\n## 8. Writing a good `agentPrompt`";

const ARCHETYPE_SECTION_PREAMBLE = `### The archetype files

Each block below is a complete file that compiles against the shipped SDK. Copy
the one you picked above into \`.boboddy/pipeline-builder/<pipeline-key>.ts\`,
then adapt it: rename the keys, rewrite every prompt for this user's domain and
vocabulary, and delete what they do not need. Never author the \`.step()\` /
\`.advance()\` alternation from scratch, and never paste an archetype without
rewriting its prompts — prompt text is where a pipeline's quality lives, and
these are written for a generic project.`;

/**
 * Render the archetypes as one markdown block.
 *
 * Fenced with three backticks, which is safe because no archetype contains a
 * fence of its own — asserted in `test/design-agent-archetypes.test.ts`.
 */
function buildArchetypeSection(): string {
  const blocks = PIPELINE_ARCHETYPES.map(
    ({ name, heading, source }) =>
      `#### \`${name}.ts\` — ${heading}\n\n\`\`\`ts\n${source.trim()}\n\`\`\``,
  );
  return [ARCHETYPE_SECTION_PREAMBLE, ...blocks].join("\n\n");
}

/** The authoring reference with the archetype sources spliced into section 7. */
export function buildPipelineAuthoringReference(): string {
  const reference = PIPELINE_AUTHORING_REFERENCE.trim();
  const at = reference.indexOf(ARCHETYPE_SPLICE_MARKER);
  if (at === -1) {
    throw new Error(
      `AUTHORING.md no longer contains ${JSON.stringify(ARCHETYPE_SPLICE_MARKER)}, ` +
        "so the archetype sources have nowhere to go. Update ARCHETYPE_SPLICE_MARKER.",
    );
  }
  return [
    reference.slice(0, at).trimEnd(),
    buildArchetypeSection(),
    reference.slice(at).trim(),
    buildHealthCheckCatalogSection(),
  ].join("\n\n");
}

/**
 * Origination rules for a step's `healthChecks` field, appended to the
 * authoring reference as section 10.
 *
 * Constrains ORIGIN, not content, because the designer cannot verify anything
 * it writes: it has no MCP servers of its own, no enforced typecheck, and push
 * validates shape only. A fabricated tool *name* is cheap to detect — the
 * runner fails on it in milliseconds — but a guessed *argument set* on a
 * *real* tool would run automatically forever with nothing to catch it.
 */
const HEALTH_CHECK_RULES = `1. Add a catalogued server's health check to \`healthChecks\` **without
   asking** — every call below is safe by construction (it navigates to a
   blank page or lists schema names), so there is nothing to confirm.
2. Add a health check for any other tool **only if the user supplied the
   tool name and arguments themselves.**
3. **Never invent a tool name or arguments.** A fabricated tool name is cheap
   to catch — the runner fails on it in milliseconds. A guessed argument set
   on a real tool is not: it runs automatically, at \`required\` severity by
   default, with nothing to catch it.`;

const HEALTH_CHECK_GUIDANCE = `- **No secrets in check arguments.** There is no interpolation mechanism, and
  the values are persisted in the database, returned by the API, and rendered
  in the UI. Put a secret in the MCP server's \`environment\` or \`headers\`
  instead, referenced as \`{env:VAR}\`.
- **Prefer tools whose output is trivial.** Health check output is logged in
  full.`;

/**
 * A markdown table listing every catalog entry, generated from
 * {@link HEALTH_CHECK_CATALOG} rather than hand-authored, so it cannot drift
 * from the data the examples below are rendered from.
 */
function buildHealthCheckCatalogTable(): string {
  const header = "| Server | Package hint | `mcpServers` key | Tool |";
  const separator = "| --- | --- | --- | --- |";
  const rows = HEALTH_CHECK_CATALOG.map(
    ({ label, packageHint, mcp, tool }) =>
      `| ${label} | \`${packageHint}\` | \`${mcp}\` | \`${tool}\` |`,
  );
  return [header, separator, ...rows].join("\n");
}

/**
 * A complete, compilable step definition demonstrating one catalog entry's
 * `mcpServers` + `healthChecks` shape.
 *
 * `command` is deliberately a placeholder string, not a launch command built
 * from `packageHint` — writing one would be exactly the literal the catalog
 * exists to avoid (see `HealthCheckCatalogEntry.packageHint`'s doc comment).
 */
export function buildHealthCheckExampleSource(
  entry: HealthCheckCatalogEntry,
): string {
  const stepKey = `${entry.id}-health-check-example`;
  const varName = `${entry.id}HealthCheckExample`;
  const argsLiteral = JSON.stringify(entry.args);
  return `import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";

export const ${varName} = defineStep({
  key: "${stepKey}",
  name: "${entry.label}",
  status: "active",
  agentPrompt: "Use the ${entry.mcp} MCP tools.",
  mcpServers: {
    ${entry.mcp}: {
      type: "local",
      // "${entry.packageHint}" is the package to launch — a hint, not a
      // literal command. See the caveats above for what this needs.
      command: ["<launch ${entry.packageHint} here>"],
      enabled: true,
    },
  },
  healthChecks: [{ mcp: "${entry.mcp}", tool: "${entry.tool}", args: ${argsLiteral} }],
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
 * Exported so `test/design-agent-archetypes.test.ts` can compile each one
 * against the real SDK through the same harness the archetypes use, the same
 * way `PIPELINE_ARCHETYPES` is compiled directly rather than re-extracted
 * from markdown.
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
 * Entirely generated — unlike the archetype catalog table, which stays
 * hand-authored in `AUTHORING.md` — because every fact here (rules, guidance,
 * and the table) is either fixed policy or catalog data, so generating all of
 * it keeps this section's only source of truth {@link HEALTH_CHECK_CATALOG}.
 */
export function buildHealthCheckCatalogSection(): string {
  return [
    "## 10. Well-known MCP server health checks",
    "A step's `healthChecks` field runs a real tool call against its launched " +
      "environment before the agent starts working. Never ask the user about " +
      "this feature; just apply the rules below.",
    HEALTH_CHECK_RULES,
    HEALTH_CHECK_GUIDANCE,
    "If this step's `mcpServers` declares one of these servers, add its row's " +
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
