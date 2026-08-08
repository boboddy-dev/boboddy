import * as clack from "@clack/prompts";
import { connectApi, describeApiError } from "./cli-api-client";
import {
  buildCreateWorkItemBody,
  formatWorkItemChoiceLabel,
  FREE_TEXT_WORK_ITEM,
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
 * The project's most recent work items.
 *
 * `pageSize` does the capping server-side: the listing's default order is
 * newest-activity-first, so page 1 is exactly the window the picker wants and
 * there is nothing to sort or slice here.
 */
export async function listRecentWorkItems(input: {
  baseUrl: string;
  projectId: string;
}): Promise<readonly DesignWorkItem[]> {
  const { client, headers } = await connectApi(input.baseUrl);

  const { data, error } = await client.projects.listProjectWorkItems({
    path: { projectId: input.projectId },
    query: { page: 1, pageSize: WORK_ITEM_PICKER_LIMIT },
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
 * The picker. The free-text rung is always last so it reads as the escape
 * hatch, and `maxItems` is sized to the whole list so it is visible without
 * scrolling.
 *
 * Its label carries a `+` prefix and a hint (shown when focused) so it does
 * not read as just one more rung in the list — it is the one option that
 * exists no matter what the project has ingested, and easy to miss otherwise
 * sitting at the bottom of up to 15 identically-styled choices.
 */
export async function promptWorkItemChoice(
  items: readonly DesignWorkItem[],
): Promise<WorkItemChoiceResult> {
  const byId = new Map(items.map((item) => [item.id, item]));

  const answer = await clack.select({
    message: "What should this pipeline handle? (Ctrl+C to cancel)",
    maxItems: WORK_ITEM_PICKER_LIMIT + 1,
    options: [
      ...items.map((item) => ({
        value: item.id,
        label: formatWorkItemChoiceLabel(item),
      })),
      {
        value: FREE_TEXT_WORK_ITEM,
        label: "+ Paste or describe a different one…",
        hint: "not listed above",
      },
    ],
  });

  if (clack.isCancel(answer)) {
    return undefined;
  }
  if (answer === FREE_TEXT_WORK_ITEM) {
    return FREE_TEXT_WORK_ITEM;
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
 * The free-text rung. Validates rather than accepting an empty line, so a stray
 * Enter re-asks instead of aborting the run — the same shape as the project-id
 * prompt.
 *
 * Deliberately does not invite pasting a link to an existing ticket: the
 * result always becomes a brand-new `boboddy`-platform item (see
 * {@link createDesignWorkItem}), never a lookup against anything already
 * ingested, so framing it as "paste a URL" would imply a resolution this
 * flow does not do.
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
