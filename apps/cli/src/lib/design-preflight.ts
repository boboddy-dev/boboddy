import {
  FREE_TEXT_WORK_ITEM,
  NO_WORK_ITEM_MESSAGE,
  SEARCH_WORK_ITEM,
} from "./design-work-item";
import { resolveFreeTextWorkItem } from "./design-work-item-resolution";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import type { EnsureOpencodeRuntimePort } from "./design-runtime";
import type {
  DesignWorkItem,
  WorkItemChoiceResult,
  WorkItemDraft,
} from "./design-work-item";
import type { BaseReporter } from "./reporter-types";

/**
 * The preflight for `boboddy pipelines design`.
 *
 * Every step is SELF-HEALING by design: the command's whole reason to exist is
 * that a new user should be able to type one thing and end up in a working
 * session. A missing session triggers a login; a missing directory is
 * scaffolded; missing dependencies are installed; a missing runtime is
 * downloaded. The single exception is provider credentials — Boboddy cannot
 * obtain an Anthropic/OpenAI key on the user's behalf, so that one hard-stops
 * with the remediation the runtime itself prints.
 *
 * All I/O is behind {@link DesignPreflightPorts} so the decision logic (which
 * branch runs when) is unit-testable without a network, a filesystem, or a
 * 100 MB download.
 */

export interface DesignPreflightPorts extends EnsureOpencodeRuntimePort {
  /** Current authenticated session for `baseUrl`, or `null` when signed out. */
  loadSession(baseUrl: string): Promise<{ email: string } | null>;
  /** Run the interactive device-code login. Resolves once signed in. */
  login(baseUrl: string): Promise<{ email: string }>;
  /** The projectId recorded in `.boboddy/boboddy.jsonc`, if any. */
  readConfiguredProjectId(): Promise<string | undefined>;
  /**
   * Identify the project for THIS repository against the server by matching
   * its git remote, and persist the id to `.boboddy/boboddy.jsonc`. Resolves
   * to `undefined` — falling through to `promptProjectId` below — both when
   * the repository cannot be identified at all (no `origin` remote, not a
   * git root) and when it's identified but no project matches its remote yet
   * (that hand-off lives in `boboddy init`, see #141; run it first).
   */
  resolveProjectFromRepo(baseUrl: string): Promise<string | undefined>;
  /** Ask the user for a projectId. `undefined` when they cancel or leave it blank. */
  promptProjectId(): Promise<string | undefined>;
  /**
   * The project's most recent work items, newest first, already capped to
   * {@link WORK_ITEM_PICKER_LIMIT} — or, when `query` is given, the top items
   * matching that keyword instead. Throwing is tolerated — the step degrades
   * to free text rather than failing the session.
   */
  listWorkItems(input: {
    baseUrl: string;
    projectId: string;
    query?: string;
  }): Promise<readonly DesignWorkItem[]>;
  /**
   * Look up one specific item by id, for `--work-item-id` and for an id typed
   * into the free-text rung. `undefined` when it does not exist, or exists but
   * belongs to a different project — either way, not a valid target for this
   * session.
   */
  getWorkItemById(input: {
    baseUrl: string;
    projectId: string;
    workItemId: string;
  }): Promise<DesignWorkItem | undefined>;
  /**
   * Resolve a pasted ticket URL typed into the free-text rung to an
   * already-ingested item. `undefined` when nothing matches — the caller falls
   * through to creating a new item from the same text.
   */
  findWorkItemByUrl(input: {
    baseUrl: string;
    projectId: string;
    url: string;
  }): Promise<DesignWorkItem | undefined>;
  /**
   * Show the picker over `items` plus the search and free-text rungs. Resolves
   * to the chosen item, {@link SEARCH_WORK_ITEM}, {@link FREE_TEXT_WORK_ITEM},
   * or `undefined` on cancel.
   */
  promptWorkItemChoice(
    items: readonly DesignWorkItem[],
  ): Promise<WorkItemChoiceResult>;
  /**
   * Take a search keyword for {@link listWorkItems}. Blank is a valid answer —
   * it clears the search — so only a cancel resolves to `undefined`.
   */
  promptWorkItemSearch(): Promise<string | undefined>;
  /**
   * Take a typed description of what the user wants handled — or a pasted
   * reference to an existing one; see `parseWorkItemReference` in
   * `design-work-item.ts`. `undefined` when the user cancels.
   */
  promptWorkItemText(): Promise<string | undefined>;
  /** Create the described item server-side and return it with its real id. */
  createWorkItem(input: {
    baseUrl: string;
    projectId: string;
    draft: WorkItemDraft;
  }): Promise<DesignWorkItem>;
  /** Does `.boboddy/pipeline-builder` already exist? */
  builderDirExists(): boolean;
  /**
   * Create `.boboddy/pipeline-builder`. Throws when the current directory is
   * not a plausible project root.
   */
  scaffoldBuilderDir(): void;
  /** Are the builder directory's dependencies installed? */
  dependenciesInstalled(): boolean;
  /** Install them. Throws with an actionable message on failure. */
  installDependencies(): Promise<void>;
  /** Check for a usable AI provider credential. */
  checkCredentials(
    launcherPath: string,
  ): Promise<OpencodeProviderCredentialCheck>;
}

export type DesignPreflightInput = {
  baseUrl: string;
  /** Positional `projectId`, when the user passed one. */
  projectIdArgument: string | undefined;
  /** `--work-item-id`, when the user passed one. Wins outright over the picker. */
  workItemIdArgument: string | undefined;
  reporter: BaseReporter;
  ports: DesignPreflightPorts;
};

export type DesignPreflightResult = {
  projectId: string;
  /** The item this session is anchored to. Always a real, persisted item. */
  workItem: DesignWorkItem;
  /** Absolute path to the provisioned `launch.sh`. */
  launcherPath: string;
  /** Provider NAMES only — never key material. */
  providers: readonly string[];
};

export const NO_PROJECT_ID_MESSAGE =
  "No project ID. Boboddy could not identify a project for this repository " +
  "automatically — run `boboddy pipelines design` from the root of a git repo " +
  "with an `origin` remote, or pass an id explicitly: " +
  "`boboddy pipelines design <projectId>`.";

// Re-exported for callers that only know this module, not `design-work-item.ts`
// where it actually lives (next to the other work-item-resolution pieces).
export { NO_WORK_ITEM_MESSAGE } from "./design-work-item";

/** The message for an explicit `--work-item-id` that does not resolve. */
export function workItemNotFoundMessage(
  workItemId: string,
  projectId: string,
): string {
  return (
    `Work item ${workItemId} was not found in project ${projectId}. Check the ` +
    "id, or omit --work-item-id to pick from the project's recent items instead."
  );
}

/**
 * Run every precondition in dependency order, healing what it can, and return
 * everything the launch needs. Throws on the two unrecoverable cases: no
 * project ID, and no AI provider credential.
 */
export async function runDesignPreflight(
  input: DesignPreflightInput,
): Promise<DesignPreflightResult> {
  const { baseUrl, reporter, ports } = input;

  await ensureSignedIn(baseUrl, reporter, ports);
  const projectId = await ensureProjectId({
    baseUrl,
    projectIdArgument: input.projectIdArgument,
    reporter,
    ports,
  });
  // Every prompt runs before the slow, non-interactive work below: a user who
  // cancels here should not have paid for a scaffold, an install, and a 100 MB
  // runtime download first.
  const workItem = await ensureWorkItem({
    baseUrl,
    projectId,
    workItemIdArgument: input.workItemIdArgument,
    reporter,
    ports,
  });
  await ensureBuilderDirectory(reporter, ports);
  const launcherPath = await ports.ensureRuntime();
  const providers = await ensureProviderCredentials(launcherPath, ports);

  reporter.success(`AI provider ready (${providers.join(", ")})`);

  return { projectId, workItem, launcherPath, providers };
}

/** Step 1 — authentication. Heals by running the device flow inline. */
async function ensureSignedIn(
  baseUrl: string,
  reporter: BaseReporter,
  ports: DesignPreflightPorts,
): Promise<void> {
  const existing = await ports.loadSession(baseUrl);
  if (existing) {
    reporter.success(`Signed in as ${existing.email}`);
    return;
  }

  reporter.info(`Not signed in to ${baseUrl}. Starting sign-in…`);
  const session = await ports.login(baseUrl);
  reporter.success(`Signed in as ${session.email}`);
}

/**
 * Step 2 — project. Mirrors `pipelines push`: the positional argument wins,
 * then `.boboddy/boboddy.jsonc`.
 *
 * Unlike push, a miss HEALS: the project is looked up on the server from the
 * repository's git remote and written to `.boboddy/boboddy.jsonc`, exactly as
 * `boboddy init` does. Asking a first-time user to paste a UUID they have
 * never seen is a dead end, not a preflight — the prompt survives for the
 * case where the repo cannot be identified at all (no `origin` remote), and
 * for the case where no project exists for it yet (run `boboddy init` first,
 * which sends the user through the browser hand-off — see #141).
 */
async function ensureProjectId(input: {
  baseUrl: string;
  projectIdArgument: string | undefined;
  reporter: BaseReporter;
  ports: DesignPreflightPorts;
}): Promise<string> {
  const { reporter, ports } = input;

  const fromArgument = input.projectIdArgument?.trim() ?? "";
  if (fromArgument.length > 0) {
    return fromArgument;
  }

  const configured = (await ports.readConfiguredProjectId())?.trim() ?? "";
  if (configured.length > 0) {
    return configured;
  }

  const resolved = await resolveProjectFromRepo(input.baseUrl, reporter, ports);
  if (resolved !== undefined) {
    return resolved;
  }

  const prompted = (await ports.promptProjectId())?.trim() ?? "";
  if (prompted.length === 0) {
    throw new Error(NO_PROJECT_ID_MESSAGE);
  }

  reporter.info("Using the project ID you entered for this session only.");
  return prompted;
}

/**
 * Match this repository to a project on the server, creating it when absent.
 * Returns `undefined` when the repository cannot be identified — the caller
 * falls back to prompting. Failure is reported, never swallowed silently.
 */
async function resolveProjectFromRepo(
  baseUrl: string,
  reporter: BaseReporter,
  ports: DesignPreflightPorts,
): Promise<string | undefined> {
  const task = reporter.startTask("Finding this repository's project…");
  try {
    const projectId = (await ports.resolveProjectFromRepo(baseUrl))?.trim();
    if (projectId === undefined || projectId.length === 0) {
      task.fail("Could not identify this repository's project");
      return undefined;
    }
    task.succeed(`Project ${projectId}`);
    return projectId;
  } catch (error) {
    task.fail("Could not identify this repository's project");
    reporter.warn(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * Step 3 — the work item.
 *
 * A design session is an interview about one concrete thing, so the item is a
 * precondition rather than an option. Every path here is self-healing, the
 * same as the rest of the preflight:
 *
 * - `--work-item-id` wins outright when it resolves — reaching for an item
 *   older than the picker's recent window is the exact case it exists for, so
 *   it skips the picker entirely rather than pre-selecting a rung in it. A
 *   miss is reported, then falls through to the picker below exactly as if
 *   the flag had never been passed: a typo'd id is not a reason to abandon a
 *   session the user could still finish by picking or describing.
 * - The picker's search rung ({@link choosePickableWorkItem}) re-queries the
 *   server with a keyword and loops back into the picker with the results,
 *   so a project with more ingested items than the recent-items window still
 *   has a path to any of them.
 * - The picker's free-text rung ({@link resolveFreeTextWorkItem}) takes either
 *   a reference to an already-ingested item — an id or a ticket URL, see
 *   `parseWorkItemReference` in `design-work-item.ts` — or a description of a
 *   new one. A reference that does not resolve is treated as a description
 *   instead, rather than failing the session.
 * - If the project has no ingested items at all — or the initial listing
 *   fails — the picker is skipped entirely and the user goes straight to the
 *   free-text rung: a one-rung picker is a keystroke that asks nothing.
 *
 * A cancel is the hard stop. There is no item-less session to fall back to.
 */
async function ensureWorkItem(input: {
  baseUrl: string;
  projectId: string;
  workItemIdArgument: string | undefined;
  reporter: BaseReporter;
  ports: DesignPreflightPorts;
}): Promise<DesignWorkItem> {
  const { baseUrl, projectId, reporter, ports } = input;

  const requestedId = input.workItemIdArgument?.trim() ?? "";
  if (requestedId.length > 0) {
    const requested = await resolveRequestedWorkItem({
      baseUrl,
      projectId,
      workItemId: requestedId,
      reporter,
      ports,
    });
    if (requested !== undefined) {
      return requested;
    }
  }

  const items = await loadPickableItems({
    baseUrl,
    projectId,
    reporter,
    ports,
  });

  if (items.length > 0) {
    const choice = await choosePickableWorkItem({
      baseUrl,
      projectId,
      items,
      reporter,
      ports,
    });
    if (choice === undefined) {
      throw new Error(NO_WORK_ITEM_MESSAGE);
    }
    if (choice !== FREE_TEXT_WORK_ITEM) {
      reporter.success(`Designing for “${choice.title}”`);
      return choice;
    }
  }

  return resolveFreeTextWorkItem({ baseUrl, projectId, reporter, ports });
}

/**
 * Resolve `--work-item-id` directly, bypassing the picker entirely. This is
 * the escape hatch for an item older than the picker's recent window — or
 * simply one the user already has the id for. Unlike a lookup FAILURE (the
 * API or network is unavailable, which still throws), a MISS — the id simply
 * does not resolve — is reported, then healed by the caller falling through
 * to the picker, the same as every other precondition here.
 */
async function resolveRequestedWorkItem(input: {
  baseUrl: string;
  projectId: string;
  workItemId: string;
  reporter: BaseReporter;
  ports: DesignPreflightPorts;
}): Promise<DesignWorkItem | undefined> {
  const { reporter, ports } = input;

  const task = reporter.startTask(`Loading work item ${input.workItemId}…`);
  let item: DesignWorkItem | undefined;
  try {
    item = await ports.getWorkItemById({
      baseUrl: input.baseUrl,
      projectId: input.projectId,
      workItemId: input.workItemId,
    });
  } catch (error) {
    task.fail("Could not load the work item");
    throw error;
  }

  if (item === undefined) {
    task.fail("Work item not found");
    reporter.warn(workItemNotFoundMessage(input.workItemId, input.projectId));
    return undefined;
  }

  task.succeed(`Designing for “${item.title}”`);
  return item;
}

/**
 * Show the picker, looping back into it whenever the user takes the search
 * rung. A cancelled search (Ctrl+C on the keyword prompt, not the picker
 * itself) is treated the same as cancelling the whole picker — there is no
 * "back to the previous list" distinct from that.
 */
async function choosePickableWorkItem(input: {
  baseUrl: string;
  projectId: string;
  items: readonly DesignWorkItem[];
  reporter: BaseReporter;
  ports: DesignPreflightPorts;
}): Promise<DesignWorkItem | typeof FREE_TEXT_WORK_ITEM | undefined> {
  const { baseUrl, projectId, reporter, ports } = input;
  let items = input.items;

  for (;;) {
    const choice = await ports.promptWorkItemChoice(items);
    if (choice !== SEARCH_WORK_ITEM) {
      return choice;
    }

    const query = await ports.promptWorkItemSearch();
    if (query === undefined) {
      return undefined;
    }
    items = await loadPickableItems({
      baseUrl,
      projectId,
      query,
      reporter,
      ports,
    });
  }
}

/**
 * Fetch the pickable items — the project's most recent, or (with `query`) the
 * top matches for a keyword — degrading to an empty list on failure. A
 * tracker outage or a permission gap is not a reason to abandon the session —
 * the user can still search again, describe what they want, or (unfiltered)
 * see an empty list and skip straight to the free-text rung.
 */
async function loadPickableItems(input: {
  baseUrl: string;
  projectId: string;
  query?: string;
  reporter: BaseReporter;
  ports: DesignPreflightPorts;
}): Promise<readonly DesignWorkItem[]> {
  const query = input.query?.trim();
  const isSearch = query !== undefined && query.length > 0;

  const task = input.reporter.startTask(
    isSearch
      ? `Searching this project's work items for “${query}”…`
      : "Loading this project's work items…",
  );
  try {
    const items = await input.ports.listWorkItems({
      baseUrl: input.baseUrl,
      projectId: input.projectId,
      query: input.query,
    });
    if (items.length === 0) {
      task.succeed(isSearch ? "No matches" : "No work items yet");
    } else {
      task.succeed(`${String(items.length)} work item(s)`);
    }
    return items;
  } catch (error) {
    task.fail(
      isSearch
        ? "Could not search this project's work items"
        : "Could not load this project's work items",
    );
    input.reporter.warn(error instanceof Error ? error.message : String(error));
    return [];
  }
}

/** Step 4 — the builder directory and its dependencies. */
async function ensureBuilderDirectory(
  reporter: BaseReporter,
  ports: DesignPreflightPorts,
): Promise<void> {
  if (ports.builderDirExists()) {
    reporter.success("Pipeline builder directory ready");
  } else {
    ports.scaffoldBuilderDir();
    reporter.success("Scaffolded the pipeline builder directory");
  }

  if (ports.dependenciesInstalled()) {
    return;
  }

  reporter.info("Installing pipeline builder dependencies…");
  await ports.installDependencies();
  reporter.success("Dependencies installed");
}

/**
 * Step 6 — provider credentials. The one UNHEALABLE stop: without a key there
 * is no model to talk to, and no amount of retrying on our side changes that.
 * (A cancelled project id or work item also stops the run, but those are the
 * user declining to answer, not Boboddy hitting a wall.)
 */
async function ensureProviderCredentials(
  launcherPath: string,
  ports: DesignPreflightPorts,
): Promise<readonly string[]> {
  const check = await ports.checkCredentials(launcherPath);
  if (!check.ok) {
    throw new Error(check.remediation);
  }
  return check.providers;
}
