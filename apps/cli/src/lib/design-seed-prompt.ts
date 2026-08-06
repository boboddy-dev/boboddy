import { DEFAULT_PIPELINE_ASSIGNMENT_FILENAME } from "@boboddy/sdk/definitions/pipelines";
import { STARTER_PIPELINE_FILENAME } from "@boboddy/worker";
import type { DesignWorkItem } from "./design-work-item";

/**
 * The opening user message for a design session.
 *
 * This is the ONLY channel that carries the preflight's chosen work item into
 * the agent — the agent's system prompt is a static build-time asset, so
 * anything session-specific has to arrive here. It is passed to the runtime as
 * `--prompt <text>`, i.e. a single argv entry.
 */

/**
 * How much of the description travels with the prompt.
 *
 * argv and the environment share one `ARG_MAX` budget at `exec` time, and the
 * agent config already spends ~50 KB of it on the system prompt. A pasted log
 * dump in a work item description could otherwise fail the launch outright, so
 * it is cut here and the agent is told to fetch the rest if it needs it.
 */
export const MAX_SEED_DESCRIPTION_LENGTH = 4_000;

export type DesignSeedPromptInput = {
  workItem: DesignWorkItem;
  /** Does `.boboddy/pipeline-builder` already contain authored definitions? */
  hasExistingDefinitions: boolean;
};

/**
 * `.ts` files in the builder directory that are not the user's design work:
 * `push.ts` is generated on every push, and the other two are written by the
 * preflight's own scaffold step moments before the flag below is read.
 */
const NOT_AUTHORED_BY_THE_USER: readonly string[] = [
  "push.ts",
  STARTER_PIPELINE_FILENAME,
  DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
];

/**
 * Has the user authored any pipeline definitions yet?
 *
 * This is the difference between "greenfield" and "edit session", which is what
 * the agent actually needs to know — so scaffolded boilerplate has to be
 * discounted. Counting every `.ts` file would report "definitions already
 * exist" on a first run, since the preflight has just written the starter
 * pipeline and the default assignment.
 *
 * Takes filenames rather than a directory so the rule is testable without one.
 */
export function hasAuthoredDefinitions(
  fileNames: readonly string[],
): boolean {
  return fileNames.some(
    (name) => name.endsWith(".ts") && !NOT_AUTHORED_BY_THE_USER.includes(name),
  );
}

const describeDescription = (description: string): string =>
  description.length <= MAX_SEED_DESCRIPTION_LENGTH
    ? description
    : `${description.slice(0, MAX_SEED_DESCRIPTION_LENGTH)}\n[truncated — read the full description from the work item in the Boboddy dashboard]`;

/** Build the seed prompt for `workItem`. Pure: same input, same string. */
export function buildDesignSeedPrompt(input: DesignSeedPromptInput): string {
  const { workItem } = input;

  // The edit-session line names the change-size gate rather than just "read
  // them first". This message is the only place that knows which kind of session
  // this is — the system prompt's gate is conditional on exactly this flag — so
  // it is worth spending a clause on the condition where the fact is known.
  const definitionsLine = input.hasExistingDefinitions
    ? "Pipeline definitions already exist in this directory — read them, then state a change-size verdict (tweak / route / new pipeline) and get it confirmed before editing any file."
    : "No pipeline definitions exist yet in this directory.";

  return [
    "Design a Boboddy pipeline for this project, anchored to this work item.",
    "",
    "## Work item",
    "",
    `- id: ${workItem.id}`,
    `- platform: ${workItem.platform}`,
    `- title: ${workItem.title}`,
    "",
    "### Description",
    "",
    describeDescription(workItem.description),
    "",
    "## Context",
    "",
    definitionsLine,
    "",
    "Start the interview.",
  ].join("\n");
}
