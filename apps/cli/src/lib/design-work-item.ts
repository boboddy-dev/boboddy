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
 * What the text becomes — a lookup against an existing item, or a brand-new
 * one — is decided in `design-preflight.ts`; see {@link parseWorkItemReference}.
 */
export const FREE_TEXT_WORK_ITEM = "free-text";

/**
 * The picker's search rung: "search for a different item".
 *
 * The recent-items window ({@link WORK_ITEM_PICKER_LIMIT}) is not viable for a
 * project with many synced items, so this rung re-queries the server with a
 * keyword instead of only ever showing the newest page.
 */
export const SEARCH_WORK_ITEM = "search";

/**
 * What the picker resolved to: an item, one of its two rungs, or a cancel.
 * {@link SEARCH_WORK_ITEM} is handled entirely by the caller looping back into
 * the picker with new items — it never escapes `design-preflight.ts`.
 */
export type WorkItemChoiceResult =
  | DesignWorkItem
  | typeof FREE_TEXT_WORK_ITEM
  | typeof SEARCH_WORK_ITEM
  | undefined;

/**
 * The hard stop when no work item was resolved — a cancelled picker, a
 * cancelled free-text prompt, or blank free text. There is no item-less
 * session to fall back to.
 */
export const NO_WORK_ITEM_MESSAGE =
  "No work item. A design session is built around one concrete thing you want " +
  "Boboddy to handle — run `boboddy pipelines design` again and either pick an " +
  "item or describe what you want handled.";

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

/** A generic UUID (any version) — work item ids are always UUID v7, but this
 *  only needs to distinguish "looks like an id" from "looks like prose". */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the free-text rung's input parsed as: a reference to resolve, or nothing. */
export type WorkItemReference =
  { kind: "id"; value: string } | { kind: "url"; value: string };

/**
 * Does this free-text input look like a reference to an EXISTING item — an id
 * or a ticket URL — rather than a description of a new one?
 *
 * Deliberately narrow: a single-line, whole-string match only. Multi-line
 * input, or a URL embedded partway through a sentence, is prose describing new
 * work, not a pasted reference, so it is left to {@link parseWorkItemDraft}.
 */
export function parseWorkItemReference(
  text: string,
): WorkItemReference | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) {
    return undefined;
  }

  if (UUID_PATTERN.test(trimmed)) {
    return { kind: "id", value: trimmed };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    if (!URL.canParse(trimmed)) {
      return undefined;
    }
    return { kind: "url", value: trimmed };
  }

  return undefined;
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
