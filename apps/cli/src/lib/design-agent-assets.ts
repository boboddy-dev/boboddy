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
