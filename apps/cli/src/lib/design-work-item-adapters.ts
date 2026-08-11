import * as clack from "@clack/prompts";
import { connectApi, describeApiError } from "./cli-api-client";
import {
  buildCreateWorkItemBody,
  formatWorkItemChoiceLabel,
  FREE_TEXT_WORK_ITEM,
  SEARCH_WORK_ITEM,
  WORK_ITEM_PICKER_LIMIT,
} from "./design-work-item";
import type {
  DesignWorkItem,
  WorkItemChoiceResult,
  WorkItemDraft,
} from "./design-work-item";

/**
 * The real implementations of the preflight's work-item ports: two `clack`
 * prompts and two API calls.
 *
 * Deliberately thin. Everything with a decision in it — which rung leads where,
 * how typed text becomes an item, what the create body contains, what the seed
 * prompt says — lives in `design-preflight.ts`, `design-work-item.ts`, and
 * `design-seed-prompt.ts`, where it is unit-tested without a terminal or a
 * network.
 */

/**
 * The project's most recent work items, or — when `query` is given — the
 * items matching that keyword. Either way `pageSize` does the capping
 * server-side: unfiltered, the listing's default order is
 * newest-activity-first, so page 1 is exactly the recency window the picker
 * wants; filtered, it is the top page of matches. Nothing to sort or slice
 * here either way.
 */
export async function listRecentWorkItems(input: {
  baseUrl: string;
  projectId: string;
  query?: string;
}): Promise<readonly DesignWorkItem[]> {
  const { client, headers } = await connectApi(input.baseUrl);

  const q = input.query?.trim();
  const { data, error } = await client.projects.listProjectWorkItems({
    path: { projectId: input.projectId },
    query: {
      page: 1,
      pageSize: WORK_ITEM_PICKER_LIMIT,
      ...(q !== undefined && q.length > 0 ? { q } : {}),
    },
    headers,
  });

  if (error !== undefined) {
    throw new Error(`Could not list work items: ${describeApiError(error)}`);
  }

  return data.items.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    platform: item.platform,
  }));
}

/**
 * Resolve a pasted ticket URL to an already-ingested item, for the free-text
 * rung's resolve-vs-create decision (see `design-preflight.ts`).
 *
 * There is no dedicated "find by URL" endpoint — `url` isn't guaranteed
 * unique, and a project rarely has enough near-duplicate URLs for that to
 * matter — so this reuses the same text-search endpoint the picker's search
 * rung does, then confirms the match client-side: `q` matches `url`
 * substring-wise, but only an exact match is a resolution, not a coincidence.
 */
export async function findWorkItemByUrl(input: {
  baseUrl: string;
  projectId: string;
  url: string;
}): Promise<DesignWorkItem | undefined> {
  const { client, headers } = await connectApi(input.baseUrl);

  const { data, error } = await client.projects.listProjectWorkItems({
    path: { projectId: input.projectId },
    query: { page: 1, pageSize: WORK_ITEM_PICKER_LIMIT, q: input.url },
    headers,
  });

  if (error !== undefined) {
    throw new Error(`Could not search work items: ${describeApiError(error)}`);
  }

  const match = data.items.find((item) => item.url === input.url);
  if (match === undefined) {
    return undefined;
  }

  return {
    id: match.id,
    title: match.title,
    description: match.description,
    platform: match.platform,
  };
}

/**
 * Look up one specific item by id, for `--work-item-id`.
 *
 * `getWorkItem` is not itself project-scoped, so a mismatch is checked
 * client-side: an id from a different project is treated the same as a 404
 * rather than silently designing against the wrong project's item.
 */
export async function getDesignWorkItemById(input: {
  baseUrl: string;
  projectId: string;
  workItemId: string;
}): Promise<DesignWorkItem | undefined> {
  const { client, headers } = await connectApi(input.baseUrl);

  const { data, error } = await client.workItems.getWorkItem({
    path: { workItemId: input.workItemId },
    headers,
  });

  if (error !== undefined) {
    if (error.status === 404) {
      return undefined;
    }
    throw new Error(
      `Could not load work item ${input.workItemId}: ${describeApiError(error)}`,
    );
  }

  if (data.projectId !== input.projectId) {
    return undefined;
  }

  return {
    id: data.id,
    title: data.title,
    description: data.description,
    platform: data.platform,
  };
}

/** Create the item the user described. See {@link buildCreateWorkItemBody}. */
export async function createDesignWorkItem(input: {
  baseUrl: string;
  projectId: string;
  draft: WorkItemDraft;
}): Promise<DesignWorkItem> {
  const { client, headers } = await connectApi(input.baseUrl);

  const { data, error } = await client.workItems.createWorkItem({
    body: buildCreateWorkItemBody({
      projectId: input.projectId,
      draft: input.draft,
    }),
    headers,
  });

  if (error !== undefined) {
    throw new Error(
      `Could not create the work item: ${describeApiError(error)}`,
    );
  }

  return {
    id: data.id,
    title: data.title,
    description: data.description,
    platform: data.platform,
  };
}

/**
 * The picker. The search and free-text rungs are always last, in that order,
 * so they read as escape hatches rather than one more item in the list, and
 * `maxItems` is sized to the whole list so it is visible without scrolling.
 *
 * Both carry a hint (shown when focused) so they do not blend into up to 15
 * identically-styled item rungs above them.
 */
export async function promptWorkItemChoice(
  items: readonly DesignWorkItem[],
): Promise<WorkItemChoiceResult> {
  const byId = new Map(items.map((item) => [item.id, item]));

  const answer = await clack.select({
    message: "What should this pipeline handle? (Ctrl+C to cancel)",
    maxItems: WORK_ITEM_PICKER_LIMIT + 2,
    options: [
      ...items.map((item) => ({
        value: item.id,
        label: formatWorkItemChoiceLabel(item),
      })),
      {
        value: SEARCH_WORK_ITEM,
        label: "Search for a different item…",
        hint: "not listed above, but ingested",
      },
      {
        value: FREE_TEXT_WORK_ITEM,
        label: "+ Paste a link/id, or describe a new one…",
        hint: "not ingested yet",
      },
    ],
  });

  if (clack.isCancel(answer)) {
    return undefined;
  }
  if (answer === FREE_TEXT_WORK_ITEM || answer === SEARCH_WORK_ITEM) {
    return answer;
  }

  const picked = byId.get(answer);
  if (picked === undefined) {
    // Unreachable: every non-sentinel option's value is an id from `items`.
    // Thrown rather than returned so it cannot be mistaken for a cancel.
    throw new Error(`The picker returned an unknown work item id: ${answer}`);
  }
  return picked;
}

/**
 * The search rung's prompt: a keyword to re-query the server with. Blank is
 * valid on purpose — submitting an empty line clears the search and shows the
 * recent-items window again, the same "no filter" meaning `q=""` has at the
 * API — so unlike {@link promptWorkItemText} there is nothing to validate.
 */
export async function promptWorkItemSearch(): Promise<string | undefined> {
  const answer = await clack.text({
    message: "Search this project's work items (Ctrl+C to cancel):",
  });

  if (clack.isCancel(answer)) {
    return undefined;
  }
  return answer;
}

/**
 * The free-text rung. Validates rather than accepting an empty line, so a stray
 * Enter re-asks instead of aborting the run — the same shape as the project-id
 * prompt.
 *
 * What the answer becomes — a lookup against an existing item, or a brand-new
 * one — is decided in `design-preflight.ts`, via `design-work-item.ts`'s
 * `parseWorkItemReference`.
 */
export async function promptWorkItemText(): Promise<string | undefined> {
  const answer = await clack.text({
    message: "Describe what you want handled (Ctrl+C to cancel):",
    validate: (value) =>
      (value ?? "").trim().length === 0
        ? "Enter a description, or press Ctrl+C."
        : undefined,
  });

  if (clack.isCancel(answer)) {
    return undefined;
  }
  return answer;
}
