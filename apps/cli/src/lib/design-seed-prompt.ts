import { DEFAULT_PIPELINE_ASSIGNMENT_FILENAME } from "@boboddy/sdk/definitions/pipelines";
import {
  STARTER_DEFAULT_PIPELINE_ASSIGNMENT_FILE,
  STARTER_PIPELINE_FILE,
  STARTER_PIPELINE_FILENAME,
} from "@boboddy/worker";
import type { RunOfferGateFailure } from "./design-run-offer-gate-marker";
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
  /**
   * The prior session's post-push run-offer gate failure (#146), if the last
   * `pipelines design` session ended with one recorded — see
   * `design-run-offer-gate-marker.ts`. `undefined` when there is nothing to
   * report, which is the common case.
   */
  priorRunOfferFailure?: RunOfferGateFailure | undefined;
  /**
   * Absolute path to the preflight's `discovered-tools.json`, or `null` when
   * it could not be written. Omitted is treated as `null`.
   */
  agentToolsManifestPath?: string | null;
};

/** `push.ts` is regenerated on every push, so it is never the user's work. */
const GENERATED_FILES: readonly string[] = ["push.ts"];

/**
 * The files the preflight's scaffold step writes moments before the flag below
 * is read, with the content it writes. They count as authored only once they
 * differ from it: the designer adapts the starter pipeline in place, so after
 * the first session `bug-pipeline.ts` is the user's own design.
 */
const SCAFFOLDED_FILES: ReadonlyMap<string, string> = new Map([
  [STARTER_PIPELINE_FILENAME, STARTER_PIPELINE_FILE],
  [DEFAULT_PIPELINE_ASSIGNMENT_FILENAME, STARTER_DEFAULT_PIPELINE_ASSIGNMENT_FILE],
]);

/**
 * Has the user authored any pipeline definitions yet?
 *
 * This is the difference between "greenfield" and "edit session", which is what
 * the agent actually needs to know — so untouched scaffold files have to be
 * discounted. Counting every `.ts` file would report "definitions already
 * exist" on a first run, since the preflight has just written the starter
 * pipeline and the default assignment.
 *
 * Takes filenames and a reader rather than a directory so the rule is testable
 * without one. `readFile` returns `undefined` when a file cannot be read, which
 * counts as authored: better an unnecessary change-size check than editing the
 * user's work as if it were boilerplate.
 */
export function hasAuthoredDefinitions(
  fileNames: readonly string[],
  readFile: (name: string) => string | undefined,
): boolean {
  return fileNames.some((name) => {
    if (!name.endsWith(".ts") || GENERATED_FILES.includes(name)) return false;
    const scaffolded = SCAFFOLDED_FILES.get(name);
    return scaffolded === undefined || readFile(name) !== scaffolded;
  });
}

/**
 * The lines that surface a prior session's post-push run-offer gate failure
 * (#146), if there is one — the closest thing phase-1 orientation has to a
 * live agent to ask, since the session that hit the failure has already
 * exited by the time it was recorded. Empty when there is nothing to report,
 * so a normal session's prompt is unchanged.
 */
function describePriorRunOfferFailure(
  failure: RunOfferGateFailure | undefined,
): string[] {
  if (!failure) return [];
  return [
    "## Before anything else",
    "",
    "The pipeline this project pushed last session failed its health-check " +
      `dry run, after that session had already exited: ${failure.summary}. ` +
      "Investigate and fix this — it is why the run offer at the end of the " +
      "last session could not queue a run — before moving on to this " +
      "session's own work.",
    "",
  ];
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

  const manifestPath = input.agentToolsManifestPath ?? null;
  const toolsLine =
    manifestPath === null
      ? "No discovered-tools manifest was written this session — read the repository's MCP and skill config directly in phase 1."
      : `The repository's MCP servers (with their listed tools) and skills are recorded in the discovered-tools manifest at ${manifestPath} — read it in phase 1.`;

  return [
    "Design a Boboddy pipeline for this project. Use this work item to frame the interview; the pipeline you write must handle any item of its kind, so keep its names and prompts free of this item's specifics.",
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
    toolsLine,
    "",
    ...describePriorRunOfferFailure(input.priorRunOfferFailure),
    "Start the interview.",
  ].join("\n");
}
