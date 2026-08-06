import { randomUUID } from "node:crypto";

/**
 * The work item that anchors a `boboddy pipelines design` session.
 *
 * The session cannot start without one: the designer agent's whole interview is
 * "what should happen when a ticket like THIS arrives", which is unanswerable in
 * the abstract. The preflight therefore resolves an item the same way it
 * resolves auth and the project id — see `lib/design-preflight.ts`.
 *
 * This module holds only the parts worth testing in isolation: turning pasted
 * free text into a creatable item, and minting a key that cannot collide.
 */

/** Everything the seed prompt and the run offer need to know about the item. */
export type DesignWorkItem = {
  id: string;
  title: string;
  description: string;
  platform: string;
};

/**
 * How many ingested items the picker offers. Enough that a real project's
 * current work is on screen, few enough that the list does not scroll past the
 * "paste or describe a different one" rung at the bottom.
 */
export const WORK_ITEM_PICKER_LIMIT = 15;

/** Items authored here are Boboddy's own, not mirrored from a tracker. */
export const DESIGN_WORK_ITEM_PLATFORM = "boboddy";

/**
 * The picker's last rung: "paste or describe a different one".
 *
 * Always offered, whether or not the project has ingested items, because the
 * thing the user actually wants to work on is frequently not in the tracker yet.
 */
export const FREE_TEXT_WORK_ITEM = "free-text";

/** What the picker resolved to: an item, the free-text rung, or a cancel. */
export type WorkItemChoiceResult =
  | DesignWorkItem
  | typeof FREE_TEXT_WORK_ITEM
  | undefined;

/** `work_items.title` is unbounded in the schema, but a picker rung is not. */
const MAX_TITLE_LENGTH = 200;

/** Title plus ` (platform)` on one terminal line. */
const MAX_LABEL_LENGTH = 90;

export type WorkItemDraft = {
  title: string;
  description: string;
};

/** Shorten to `limit` characters, marking the cut with an ellipsis. */
const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/**
 * Split typed text into a creatable item: first line as the title, everything
 * after it as the description.
 *
 * A single line — the common case, since users type one short sentence —
 * reuses the text as the description rather than sending an empty one, which
 * the API rejects (`description` is `min(1)`). The description keeps the
 * untruncated text even when the title has to be shortened, so nothing the
 * user typed is lost.
 *
 * Returns `undefined` for blank input so the caller can re-ask rather than
 * create a titleless item.
 */
export function parseWorkItemDraft(text: string): WorkItemDraft | undefined {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const newlineIndex = normalized.indexOf("\n");
  if (newlineIndex === -1) {
    return {
      title: truncate(normalized, MAX_TITLE_LENGTH),
      description: normalized,
    };
  }

  const firstLine = normalized.slice(0, newlineIndex).trim();
  const remainder = normalized.slice(newlineIndex + 1).trim();

  return {
    title: truncate(firstLine, MAX_TITLE_LENGTH),
    description: remainder.length > 0 ? remainder : firstLine,
  };
}

/**
 * A `platformKey` for an item authored in the CLI.
 *
 * `(projectId, platform, platformKey)` is the server's uniqueness key, so a
 * fixed or derived key would make the user's second design session 409 on a
 * conflict. A UUID sidesteps that entirely; the prefix keeps the origin legible
 * in the dashboard.
 */
export function buildWorkItemPlatformKey(): string {
  return `design-${randomUUID()}`;
}

/** One picker rung: what the item is, and where it came from. */
export function formatWorkItemChoiceLabel(item: DesignWorkItem): string {
  const suffix = ` (${item.platform})`;
  return `${truncate(item.title.trim(), MAX_LABEL_LENGTH - suffix.length)}${suffix}`;
}

/**
 * The `POST /api/work-items` body for an item authored in the CLI.
 *
 * Pure, and separated from the request so the parts that would silently break
 * the create are covered by tests: the platform, the generated key, and the
 * nulls. `sourceCreatedAt`/`sourceUpdatedAt` are null because there is no
 * upstream record to date this from — the item originates here.
 */
export function buildCreateWorkItemBody(input: {
  projectId: string;
  draft: WorkItemDraft;
}): {
  projectId: string;
  platform: typeof DESIGN_WORK_ITEM_PLATFORM;
  platformId: null;
  platformKey: string;
  url: null;
  title: string;
  description: string;
  sourceCreatedAt: null;
  sourceUpdatedAt: null;
  fields: null;
} {
  return {
    projectId: input.projectId,
    platform: DESIGN_WORK_ITEM_PLATFORM,
    platformId: null,
    platformKey: buildWorkItemPlatformKey(),
    url: null,
    title: input.draft.title,
    description: input.draft.description,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    fields: null,
  };
}
