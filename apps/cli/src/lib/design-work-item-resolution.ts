import {
  NO_WORK_ITEM_MESSAGE,
  parseWorkItemDraft,
  parseWorkItemReference,
} from "./design-work-item";
import type { DesignWorkItem, WorkItemDraft } from "./design-work-item";
import type { BaseReporter } from "./reporter-types";

/**
 * The free-text rung's resolve-vs-create decision (see `design-preflight.ts`,
 * `ensureWorkItem`). Split out from `design-preflight.ts` purely to stay under
 * this repo's per-file line budget — the two live together conceptually, and
 * both are unit-tested through `runDesignPreflight` in
 * `design-preflight.test.ts`.
 *
 * Typed against this narrow port subset, not the full `DesignPreflightPorts`,
 * so this module has no dependency on `design-preflight.ts` — `ports` there
 * satisfies this structurally, with no cast needed.
 */
export type WorkItemReferencePorts = {
  getWorkItemById(input: {
    baseUrl: string;
    projectId: string;
    workItemId: string;
  }): Promise<DesignWorkItem | undefined>;
  findWorkItemByUrl(input: {
    baseUrl: string;
    projectId: string;
    url: string;
  }): Promise<DesignWorkItem | undefined>;
  promptWorkItemText(): Promise<string | undefined>;
  createWorkItem(input: {
    baseUrl: string;
    projectId: string;
    draft: WorkItemDraft;
  }): Promise<DesignWorkItem>;
};

/**
 * The free-text rung: take typed input and either resolve it against an
 * already-ingested item or create a new one from it. See
 * {@link resolveWorkItemReference} for the resolve half.
 */
export async function resolveFreeTextWorkItem(input: {
  baseUrl: string;
  projectId: string;
  reporter: BaseReporter;
  ports: WorkItemReferencePorts;
}): Promise<DesignWorkItem> {
  const { baseUrl, projectId, reporter, ports } = input;

  const text = await ports.promptWorkItemText();
  if (text === undefined) {
    throw new Error(NO_WORK_ITEM_MESSAGE);
  }

  const resolved = await resolveWorkItemReference({
    baseUrl,
    projectId,
    text,
    reporter,
    ports,
  });
  if (resolved !== undefined) {
    reporter.success(`Designing for “${resolved.title}”`);
    return resolved;
  }

  const draft = parseWorkItemDraft(text);
  if (draft === undefined) {
    throw new Error(NO_WORK_ITEM_MESSAGE);
  }

  const task = reporter.startTask("Creating the work item…");
  try {
    const created = await ports.createWorkItem({ baseUrl, projectId, draft });
    task.succeed(`Created “${created.title}”`);
    return created;
  } catch (error) {
    task.fail("Could not create the work item");
    throw error;
  }
}

/**
 * Does the free-text input look like a reference to an existing item — an id
 * or a ticket URL, see `parseWorkItemReference` in `design-work-item.ts` —
 * and if so, does it resolve? Returns `undefined` for plain prose AND for a
 * reference that does not resolve; either way the caller creates a new item
 * from the same text, the pasted id/URL becoming its title.
 */
async function resolveWorkItemReference(input: {
  baseUrl: string;
  projectId: string;
  text: string;
  reporter: BaseReporter;
  ports: WorkItemReferencePorts;
}): Promise<DesignWorkItem | undefined> {
  const { baseUrl, projectId, reporter, ports } = input;
  const reference = parseWorkItemReference(input.text);
  if (reference === undefined) {
    return undefined;
  }

  const task = reporter.startTask(`Looking up ${reference.value}…`);
  try {
    const found =
      reference.kind === "id"
        ? await ports.getWorkItemById({
            baseUrl,
            projectId,
            workItemId: reference.value,
          })
        : await ports.findWorkItemByUrl({
            baseUrl,
            projectId,
            url: reference.value,
          });

    if (found === undefined) {
      task.fail("Not found — describing it as a new item instead");
      return undefined;
    }
    task.succeed(`Found “${found.title}”`);
    return found;
  } catch (error) {
    // A lookup failure here is tolerated, not surfaced: unlike
    // `--work-item-id`, the user never explicitly asked for a lookup — the
    // text merely happens to look like one — so a network hiccup degrades to
    // treating it as a description rather than failing the session.
    task.fail("Could not resolve — describing it as a new item instead");
    reporter.warn(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
