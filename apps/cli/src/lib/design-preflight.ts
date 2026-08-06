import { FREE_TEXT_WORK_ITEM, parseWorkItemDraft } from "./design-work-item";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
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

export interface DesignPreflightPorts {
  /** Current authenticated session for `baseUrl`, or `null` when signed out. */
  loadSession(baseUrl: string): Promise<{ email: string } | null>;
  /** Run the interactive device-code login. Resolves once signed in. */
  login(baseUrl: string): Promise<{ email: string }>;
  /** The projectId recorded in `.boboddy/boboddy.jsonc`, if any. */
  readConfiguredProjectId(): Promise<string | undefined>;
  /**
   * Identify the project for THIS repository against the server — matching it
   * by git remote, creating it when it does not exist yet — and persist the id
   * to `.boboddy/boboddy.jsonc`. Throws when the repository cannot be
   * identified (no `origin` remote, not a git root).
   */
  resolveProjectFromRepo(baseUrl: string): Promise<string | undefined>;
  /** Ask the user for a projectId. `undefined` when they cancel or leave it blank. */
  promptProjectId(): Promise<string | undefined>;
  /**
   * The project's most recent work items, newest first, already capped to
   * {@link WORK_ITEM_PICKER_LIMIT}. Throwing is tolerated — the step degrades
   * to free text rather than failing the session.
   */
  listWorkItems(input: {
    baseUrl: string;
    projectId: string;
  }): Promise<readonly DesignWorkItem[]>;
  /**
   * Show the picker over `items` plus the free-text rung. Resolves to the
   * chosen item, {@link FREE_TEXT_WORK_ITEM}, or `undefined` on cancel.
   */
  promptWorkItemChoice(
    items: readonly DesignWorkItem[],
  ): Promise<WorkItemChoiceResult>;
  /**
   * Take a typed description of what the user wants handled. `undefined` when
   * the user cancels.
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
  /**
   * Provision the host-native OpenCode runtime and return the absolute
   * launcher path. Throws with an actionable message on failure.
   */
  ensureRuntime(): Promise<string>;
  /** Check for a usable AI provider credential. */
  checkCredentials(launcherPath: string): Promise<OpencodeProviderCredentialCheck>;
}

export type DesignPreflightInput = {
  baseUrl: string;
  /** Positional `projectId`, when the user passed one. */
  projectIdArgument: string | undefined;
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

export const NO_WORK_ITEM_MESSAGE =
  "No work item. A design session is built around one concrete thing you want " +
  "Boboddy to handle — run `boboddy pipelines design` again and either pick an " +
  "item or describe what you want handled.";

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
  const workItem = await ensureWorkItem({ baseUrl, projectId, reporter, ports });
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
 * Unlike push, a miss HEALS: the project is looked up (or created) on the
 * server from the repository's git remote and written to
 * `.boboddy/boboddy.jsonc`, exactly as `boboddy init` does. Asking a first-time
 * user to paste a UUID they have never seen is a dead end, not a preflight —
 * the prompt survives only for the case where the repo cannot be identified at
 * all (no `origin` remote), where there is genuinely nothing to derive.
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
 * precondition rather than an option; there are deliberately no flags for it.
 * It heals the same way the rest of the preflight does: if the project has
 * ingested items the user picks one, and if it has none — or the listing fails,
 * or nothing in the list is what they care about — they describe what they
 * want handled and it becomes a real item server-side.
 *
 * A cancel is the hard stop. There is no item-less session to fall back to.
 */
async function ensureWorkItem(input: {
  baseUrl: string;
  projectId: string;
  reporter: BaseReporter;
  ports: DesignPreflightPorts;
}): Promise<DesignWorkItem> {
  const { reporter, ports } = input;

  const items = await loadPickableItems(input);

  // An empty list means a one-rung picker, which is a keystroke that asks
  // nothing. Skip straight to describing an item.
  if (items.length > 0) {
    const choice = await ports.promptWorkItemChoice(items);
    if (choice === undefined) {
      throw new Error(NO_WORK_ITEM_MESSAGE);
    }
    if (choice !== FREE_TEXT_WORK_ITEM) {
      reporter.success(`Designing for “${choice.title}”`);
      return choice;
    }
  }

  const text = await ports.promptWorkItemText();
  const draft = text === undefined ? undefined : parseWorkItemDraft(text);
  if (draft === undefined) {
    throw new Error(NO_WORK_ITEM_MESSAGE);
  }

  const task = reporter.startTask("Creating the work item…");
  try {
    const created = await ports.createWorkItem({
      baseUrl: input.baseUrl,
      projectId: input.projectId,
      draft,
    });
    task.succeed(`Created “${created.title}”`);
    return created;
  } catch (error) {
    task.fail("Could not create the work item");
    throw error;
  }
}

/**
 * Fetch the pickable items, degrading to an empty list on failure. A tracker
 * outage or a permission gap is not a reason to abandon the session — the user
 * can still describe what they want to work on.
 */
async function loadPickableItems(input: {
  baseUrl: string;
  projectId: string;
  reporter: BaseReporter;
  ports: DesignPreflightPorts;
}): Promise<readonly DesignWorkItem[]> {
  const task = input.reporter.startTask("Loading this project's work items…");
  try {
    const items = await input.ports.listWorkItems({
      baseUrl: input.baseUrl,
      projectId: input.projectId,
    });
    if (items.length === 0) {
      task.succeed("No work items yet");
    } else {
      task.succeed(`${String(items.length)} work item(s)`);
    }
    return items;
  } catch (error) {
    task.fail("Could not load this project's work items");
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
