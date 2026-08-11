import { describe, expect, test } from "bun:test";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import {
  NO_PROJECT_ID_MESSAGE,
  NO_WORK_ITEM_MESSAGE,
  runDesignPreflight,
  type DesignPreflightPorts,
} from "../src/lib/design-preflight";
import {
  FREE_TEXT_WORK_ITEM,
  type DesignWorkItem,
  type WorkItemDraft,
} from "../src/lib/design-work-item";
import { noopBaseReporter } from "../src/lib/reporter-types";

/**
 * The preflight's contract is "heal everything except a missing AI key", so
 * these tests are all about which branch runs: each precondition is exercised
 * both present and absent, and the one hard stop is pinned.
 *
 * Every port is a spy — no network, no filesystem, no 100 MB download.
 */

const BASE_URL = "https://app.example.com";
const LAUNCHER = "/home/u/.boboddy/runtimes/opencode/1.18.11/launch.sh";
const OK_CREDENTIALS: OpencodeProviderCredentialCheck = {
  ok: true,
  providers: ["anthropic"],
};

const INGESTED_ITEM: DesignWorkItem = {
  id: "0197f000-0000-7000-8000-000000000001",
  title: "Checkout 500s on submit",
  description: "Only on Safari 17.",
  platform: "github",
};

const CREATED_ITEM: DesignWorkItem = {
  id: "0197f000-0000-7000-8000-000000000002",
  title: "Flaky login test",
  description: "Fails one run in five.",
  platform: "boboddy",
};

type Calls = {
  login: number;
  resolveProjectFromRepo: number;
  promptProjectId: number;
  listWorkItems: number;
  getWorkItemById: number;
  findWorkItemByUrl: number;
  promptWorkItemChoice: number;
  promptWorkItemSearch: number;
  promptWorkItemText: number;
  createWorkItem: number;
  scaffoldBuilderDir: number;
  installDependencies: number;
  ensureRuntime: number;
};

type PortOverrides = Partial<DesignPreflightPorts>;

function createPorts(overrides: PortOverrides = {}): {
  ports: DesignPreflightPorts;
  calls: Calls;
} {
  const calls: Calls = {
    login: 0,
    resolveProjectFromRepo: 0,
    promptProjectId: 0,
    listWorkItems: 0,
    getWorkItemById: 0,
    findWorkItemByUrl: 0,
    promptWorkItemChoice: 0,
    promptWorkItemSearch: 0,
    promptWorkItemText: 0,
    createWorkItem: 0,
    scaffoldBuilderDir: 0,
    installDependencies: 0,
    ensureRuntime: 0,
  };

  // The "everything already set up" baseline; each test negates one thing.
  const base: DesignPreflightPorts = {
    loadSession: () => Promise.resolve({ email: "user@example.com" }),
    login: () => {
      calls.login += 1;
      return Promise.resolve({ email: "fresh@example.com" });
    },
    readConfiguredProjectId: () => Promise.resolve("project-from-config"),
    resolveProjectFromRepo: () => {
      calls.resolveProjectFromRepo += 1;
      return Promise.resolve("project-from-repo");
    },
    promptProjectId: () => {
      calls.promptProjectId += 1;
      return Promise.resolve("project-from-prompt");
    },
    listWorkItems: () => {
      calls.listWorkItems += 1;
      return Promise.resolve([INGESTED_ITEM]);
    },
    getWorkItemById: () => {
      calls.getWorkItemById += 1;
      return Promise.resolve(undefined);
    },
    findWorkItemByUrl: () => {
      calls.findWorkItemByUrl += 1;
      return Promise.resolve(undefined);
    },
    promptWorkItemChoice: () => {
      calls.promptWorkItemChoice += 1;
      return Promise.resolve(INGESTED_ITEM);
    },
    promptWorkItemSearch: () => {
      calls.promptWorkItemSearch += 1;
      return Promise.resolve(undefined);
    },
    promptWorkItemText: () => {
      calls.promptWorkItemText += 1;
      return Promise.resolve("Flaky login test\nFails one run in five.");
    },
    createWorkItem: () => {
      calls.createWorkItem += 1;
      return Promise.resolve(CREATED_ITEM);
    },
    builderDirExists: () => true,
    scaffoldBuilderDir: () => {
      calls.scaffoldBuilderDir += 1;
    },
    dependenciesInstalled: () => true,
    installDependencies: () => {
      calls.installDependencies += 1;
      return Promise.resolve();
    },
    ensureRuntime: () => {
      calls.ensureRuntime += 1;
      return Promise.resolve(LAUNCHER);
    },
    checkCredentials: () => Promise.resolve(OK_CREDENTIALS),
  };

  return { ports: { ...base, ...overrides }, calls };
}

/**
 * Await a rejection and hand back the error. Preferred over
 * `expect(...).rejects` here because it is genuinely awaited: these tests go on
 * to assert on side effects that must NOT have happened after the throw.
 */
async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Expected an Error, received ${String(error)}`);
  }
  throw new Error("Expected the preflight to reject, but it resolved.");
}

function run(
  ports: DesignPreflightPorts,
  projectIdArgument?: string,
  workItemIdArgument?: string,
) {
  return runDesignPreflight({
    baseUrl: BASE_URL,
    projectIdArgument,
    workItemIdArgument,
    reporter: noopBaseReporter,
    ports,
  });
}

describe("runDesignPreflight — happy path", () => {
  test("does nothing when every precondition is already satisfied", async () => {
    const { ports, calls } = createPorts();

    const result = await run(ports);

    expect(result).toEqual({
      projectId: "project-from-config",
      workItem: INGESTED_ITEM,
      launcherPath: LAUNCHER,
      providers: ["anthropic"],
    });
    expect(calls.login).toBe(0);
    expect(calls.resolveProjectFromRepo).toBe(0);
    expect(calls.promptProjectId).toBe(0);
    expect(calls.createWorkItem).toBe(0);
    expect(calls.scaffoldBuilderDir).toBe(0);
    expect(calls.installDependencies).toBe(0);
    expect(calls.ensureRuntime).toBe(1);
  });
});

describe("runDesignPreflight — project id", () => {
  test("the positional argument wins over the config", async () => {
    const { ports, calls } = createPorts();

    const result = await run(ports, "project-from-arg");

    expect(result.projectId).toBe("project-from-arg");
    expect(calls.resolveProjectFromRepo).toBe(0);
    expect(calls.promptProjectId).toBe(0);
  });

  test("falls back to the config file", async () => {
    const { ports } = createPorts();

    expect((await run(ports)).projectId).toBe("project-from-config");
  });

  test("resolves the project from the repository when the config is empty", async () => {
    // The regression this pins: an unconfigured repo used to dead-end on a
    // prompt for a UUID the user had never seen.
    const { ports, calls } = createPorts({
      readConfiguredProjectId: () => Promise.resolve(undefined),
    });

    const result = await run(ports);

    expect(result.projectId).toBe("project-from-repo");
    expect(calls.resolveProjectFromRepo).toBe(1);
    expect(calls.promptProjectId).toBe(0);
  });

  test("treats a whitespace-only argument as absent", async () => {
    const { ports } = createPorts();

    expect((await run(ports, "   ")).projectId).toBe("project-from-config");
  });

  test("prompts only when the repository cannot be identified", async () => {
    const { ports, calls } = createPorts({
      readConfiguredProjectId: () => Promise.resolve(undefined),
      resolveProjectFromRepo: () =>
        Promise.reject(new Error("no origin remote")),
    });

    const result = await run(ports);

    expect(result.projectId).toBe("project-from-prompt");
    expect(calls.promptProjectId).toBe(1);
  });

  test("prompts when the repository resolves to nothing", async () => {
    const { ports, calls } = createPorts({
      readConfiguredProjectId: () => Promise.resolve(undefined),
      resolveProjectFromRepo: () => Promise.resolve(undefined),
    });

    expect((await run(ports)).projectId).toBe("project-from-prompt");
    expect(calls.promptProjectId).toBe(1);
  });

  test("fails when the prompt is cancelled", async () => {
    const { ports } = createPorts({
      readConfiguredProjectId: () => Promise.resolve(undefined),
      resolveProjectFromRepo: () => Promise.resolve(undefined),
      promptProjectId: () => Promise.resolve(undefined),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe(NO_PROJECT_ID_MESSAGE);
  });
});

describe("runDesignPreflight — work item", () => {
  test("launches with the item the user picked", async () => {
    const { ports, calls } = createPorts();

    const result = await run(ports);

    expect(result.workItem).toEqual(INGESTED_ITEM);
    expect(calls.promptWorkItemChoice).toBe(1);
    expect(calls.promptWorkItemText).toBe(0);
    expect(calls.createWorkItem).toBe(0);
  });

  test("lists the items for the resolved project", async () => {
    let seen: { baseUrl: string; projectId: string } | undefined;
    const { ports } = createPorts({
      listWorkItems: (input) => {
        seen = input;
        return Promise.resolve([INGESTED_ITEM]);
      },
    });

    await run(ports, "project-from-arg");

    expect(seen).toEqual({ baseUrl: BASE_URL, projectId: "project-from-arg" });
  });

  test("skips the picker entirely when the project has no items", async () => {
    // A brand-new project is the common case; showing a one-rung picker there
    // is a pointless keystroke.
    const { ports, calls } = createPorts({
      listWorkItems: () => Promise.resolve([]),
    });

    const result = await run(ports);

    expect(calls.promptWorkItemChoice).toBe(0);
    expect(calls.promptWorkItemText).toBe(1);
    expect(result.workItem).toEqual(CREATED_ITEM);
  });

  test("creates the pasted item against the resolved project", async () => {
    let seen:
      { baseUrl: string; projectId: string; draft: WorkItemDraft } | undefined;
    const { ports } = createPorts({
      listWorkItems: () => Promise.resolve([]),
      createWorkItem: (input) => {
        seen = input;
        return Promise.resolve(CREATED_ITEM);
      },
    });

    await run(ports, "project-from-arg");

    expect(seen).toEqual({
      baseUrl: BASE_URL,
      projectId: "project-from-arg",
      draft: {
        title: "Flaky login test",
        description: "Fails one run in five.",
      },
    });
  });

  test("takes the free-text rung when the user asks for it", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemChoice: () => Promise.resolve(FREE_TEXT_WORK_ITEM),
    });

    const result = await run(ports);

    expect(calls.promptWorkItemText).toBe(1);
    expect(calls.createWorkItem).toBe(1);
    expect(result.workItem).toEqual(CREATED_ITEM);
  });

  test("falls through to free text when the listing fails", async () => {
    // A listing failure is not a reason to abandon the session: the user can
    // still describe what they want to work on.
    const { ports, calls } = createPorts({
      listWorkItems: () => Promise.reject(new Error("network down")),
    });

    const result = await run(ports);

    expect(calls.promptWorkItemChoice).toBe(0);
    expect(result.workItem).toEqual(CREATED_ITEM);
  });

  test("fails when the picker is cancelled", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemChoice: () => Promise.resolve(undefined),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe(NO_WORK_ITEM_MESSAGE);
    expect(calls.ensureRuntime).toBe(0);
  });

  test("fails when the free-text prompt is cancelled", async () => {
    const { ports, calls } = createPorts({
      listWorkItems: () => Promise.resolve([]),
      promptWorkItemText: () => Promise.resolve(undefined),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe(NO_WORK_ITEM_MESSAGE);
    expect(calls.createWorkItem).toBe(0);
  });

  test("fails on blank free text rather than creating an untitled item", async () => {
    const { ports, calls } = createPorts({
      listWorkItems: () => Promise.resolve([]),
      promptWorkItemText: () => Promise.resolve("   \n\t "),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe(NO_WORK_ITEM_MESSAGE);
    expect(calls.createWorkItem).toBe(0);
  });

  test("cancelling costs nothing — no scaffold, no install, no download", async () => {
    // Every interactive prompt runs before the slow, non-interactive work.
    const { ports, calls } = createPorts({
      builderDirExists: () => false,
      dependenciesInstalled: () => false,
      promptWorkItemChoice: () => Promise.resolve(undefined),
    });

    await expectRejection(run(ports));

    expect(calls.scaffoldBuilderDir).toBe(0);
    expect(calls.installDependencies).toBe(0);
    expect(calls.ensureRuntime).toBe(0);
  });

  test("a failing create surfaces its own error", async () => {
    const { ports } = createPorts({
      listWorkItems: () => Promise.resolve([]),
      createWorkItem: () =>
        Promise.reject(new Error("Failed to create work item: 403")),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe("Failed to create work item: 403");
  });
});

describe("runDesignPreflight — builder directory", () => {
  test("scaffolds when the directory is missing", async () => {
    const { ports, calls } = createPorts({ builderDirExists: () => false });

    await run(ports);

    expect(calls.scaffoldBuilderDir).toBe(1);
  });

  test("does not scaffold when the directory exists", async () => {
    const { ports, calls } = createPorts();

    await run(ports);

    expect(calls.scaffoldBuilderDir).toBe(0);
  });

  test("installs dependencies when they are missing", async () => {
    const { ports, calls } = createPorts({
      dependenciesInstalled: () => false,
    });

    await run(ports);

    expect(calls.installDependencies).toBe(1);
  });

  test("skips the install when the sdk is already present", async () => {
    const { ports, calls } = createPorts();

    await run(ports);

    expect(calls.installDependencies).toBe(0);
  });

  test("a failing install aborts before the runtime download", async () => {
    // Ordering matters: there is no point pulling 100 MB for a directory that
    // cannot compile.
    const { ports, calls } = createPorts({
      dependenciesInstalled: () => false,
      installDependencies: () => Promise.reject(new Error("install exploded")),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe("install exploded");
    expect(calls.ensureRuntime).toBe(0);
  });
});

describe("runDesignPreflight — provider credentials", () => {
  test("hard-stops with the remediation when no credential is found", async () => {
    // The one thing the command cannot heal: we can't obtain the user's API key.
    const remediation =
      'No AI provider credentials were found.\n\n  "…" auth login';
    const { ports } = createPorts({
      checkCredentials: () => Promise.resolve({ ok: false, remediation }),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe(remediation);
  });

  test("the credential check runs against the provisioned launcher", async () => {
    let seen: string | undefined;
    const { ports } = createPorts({
      checkCredentials: (launcherPath) => {
        seen = launcherPath;
        return Promise.resolve(OK_CREDENTIALS);
      },
    });

    await run(ports);

    expect(seen).toBe(LAUNCHER);
  });

  test("reports provider names, and only names", async () => {
    const { ports } = createPorts({
      checkCredentials: () =>
        Promise.resolve({ ok: true, providers: ["anthropic", "openai"] }),
    });

    expect((await run(ports)).providers).toEqual(["anthropic", "openai"]);
  });
});
