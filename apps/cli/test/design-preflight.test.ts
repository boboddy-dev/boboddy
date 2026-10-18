import { describe, expect, test } from "bun:test";
import {
  NO_PROJECT_ID_MESSAGE,
  NO_WORK_ITEM_MESSAGE,
} from "../src/lib/design-preflight";
import {
  FREE_TEXT_WORK_ITEM,
  type WorkItemDraft,
} from "../src/lib/design-work-item";
import { FAKE_AGENT_TOOLS_MANIFEST_PATH } from "./design-agent-tools-fakes";
import {
  BASE_URL,
  CREATED_ITEM,
  INGESTED_ITEM,
  LAUNCHER,
  createPorts,
  expectRejection,
  idOf,
  run,
} from "./design-preflight-fakes";

/**
 * The preflight's contract is "heal everything", so these tests are all about
 * which branch runs: each precondition is exercised both present and absent.
 *
 * Every port is a spy — no network, no filesystem, no 100 MB download.
 */

describe("runDesignPreflight — happy path", () => {
  test("does nothing when every precondition is already satisfied", async () => {
    const { ports, calls } = createPorts();

    const result = await run(ports);

    expect(result).toEqual({
      projectId: idOf("project-from-config"),
      project: "project-from-config",
      workItem: INGESTED_ITEM,
      launcherPath: LAUNCHER,
      providers: ["anthropic"],
      agentToolsManifestPath: FAKE_AGENT_TOOLS_MANIFEST_PATH,
    });
    expect(calls.login).toBe(0);
    expect(calls.resolveProjectFromRepo).toBe(0);
    expect(calls.promptProject).toBe(0);
    expect(calls.createWorkItem).toBe(0);
    expect(calls.scaffoldBuilderDir).toBe(0);
    expect(calls.installDependencies).toBe(0);
    expect(calls.ensureRuntime).toBe(1);
  });
});

describe("runDesignPreflight — project", () => {
  test("the positional argument wins over the config", async () => {
    const { ports, calls } = createPorts();

    const result = await run(ports, "project-from-arg");

    expect(result.project).toBe("project-from-arg");
    expect(result.projectId).toBe(idOf("project-from-arg"));
    expect(calls.resolveProjectFromRepo).toBe(0);
    expect(calls.promptProject).toBe(0);
  });

  test("falls back to the config file", async () => {
    const { ports } = createPorts();

    expect((await run(ports)).project).toBe("project-from-config");
  });

  test("resolves the project from the repository when the config is empty", async () => {
    // The regression this pins: an unconfigured repo used to dead-end on a
    // prompt for a UUID the user had never seen.
    const { ports, calls } = createPorts({
      readConfiguredProject: () => Promise.resolve(undefined),
    });

    const result = await run(ports);

    expect(result.project).toBe("project-from-repo");
    expect(calls.resolveProjectFromRepo).toBe(1);
    expect(calls.promptProject).toBe(0);
  });

  test("treats a whitespace-only argument as absent", async () => {
    const { ports } = createPorts();

    expect((await run(ports, "   ")).project).toBe("project-from-config");
  });

  test("prompts only when the repository cannot be identified", async () => {
    const { ports, calls } = createPorts({
      readConfiguredProject: () => Promise.resolve(undefined),
      resolveProjectFromRepo: () =>
        Promise.reject(new Error("no origin remote")),
    });

    const result = await run(ports);

    expect(result.project).toBe("project-from-prompt");
    expect(calls.promptProject).toBe(1);
  });

  test("prompts when the repository resolves to nothing", async () => {
    const { ports, calls } = createPorts({
      readConfiguredProject: () => Promise.resolve(undefined),
      resolveProjectFromRepo: () => Promise.resolve(undefined),
    });

    expect((await run(ports)).project).toBe("project-from-prompt");
    expect(calls.promptProject).toBe(1);
  });

  test("fails when the prompt is cancelled", async () => {
    const { ports } = createPorts({
      readConfiguredProject: () => Promise.resolve(undefined),
      resolveProjectFromRepo: () => Promise.resolve(undefined),
      promptProject: () => Promise.resolve(undefined),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe(NO_PROJECT_ID_MESSAGE);
  });

  test("resolves the chosen ref exactly once", async () => {
    const seen: Array<{ baseUrl: string; ref: string }> = [];
    const { ports } = createPorts({
      resolveProjectRef: (input) => {
        seen.push(input);
        return Promise.resolve({ id: "uuid", owner: "acme", slug: "web-app" });
      },
    });

    const result = await run(ports, "acme/web-app");

    expect(seen).toEqual([{ baseUrl: BASE_URL, ref: "acme/web-app" }]);
    expect(result).toMatchObject({
      projectId: "uuid",
      project: "acme/web-app",
    });
  });

  test("fails before any work-item prompt when the ref does not resolve", async () => {
    const { ports, calls } = createPorts({
      resolveProjectRef: () =>
        Promise.reject(
          new Error(
            "You don't have permission to design pipelines for acme/web-app.",
          ),
        ),
    });

    const error = await expectRejection(run(ports, "acme/web-app"));

    expect(error.message).toBe(
      "You don't have permission to design pipelines for acme/web-app.",
    );
    expect(calls.listWorkItems).toBe(0);
    expect(calls.promptWorkItemChoice).toBe(0);
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

    expect(seen).toEqual({
      baseUrl: BASE_URL,
      projectId: idOf("project-from-arg"),
    });
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
      projectId: idOf("project-from-arg"),
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
