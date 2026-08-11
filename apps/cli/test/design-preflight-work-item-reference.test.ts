import { describe, expect, test } from "bun:test";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import {
  runDesignPreflight,
  type DesignPreflightPorts,
} from "../src/lib/design-preflight";
import {
  FREE_TEXT_WORK_ITEM,
  type DesignWorkItem,
} from "../src/lib/design-work-item";
import { noopBaseReporter } from "../src/lib/reporter-types";

/**
 * The free-text rung's resolve-vs-create decision: a pasted id or ticket URL
 * resolves against what the project already has ingested, distinct from
 * describing brand-new work. Split from `design-preflight.test.ts` (which
 * covers every other precondition) purely to stay under this repo's per-file
 * line budget.
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

function createPorts(overrides: Partial<DesignPreflightPorts> = {}) {
  const calls = {
    getWorkItemById: 0,
    findWorkItemByUrl: 0,
    createWorkItem: 0,
  };
  const base: DesignPreflightPorts = {
    loadSession: () => Promise.resolve({ email: "user@example.com" }),
    login: () => Promise.resolve({ email: "user@example.com" }),
    readConfiguredProjectId: () => Promise.resolve("project-from-config"),
    resolveProjectFromRepo: () => Promise.resolve("project-from-repo"),
    promptProjectId: () => Promise.resolve(undefined),
    listWorkItems: () => Promise.resolve([INGESTED_ITEM]),
    getWorkItemById: () => {
      calls.getWorkItemById += 1;
      return Promise.resolve(undefined);
    },
    findWorkItemByUrl: () => {
      calls.findWorkItemByUrl += 1;
      return Promise.resolve(undefined);
    },
    promptWorkItemChoice: () => Promise.resolve(FREE_TEXT_WORK_ITEM),
    promptWorkItemSearch: () => Promise.resolve(undefined),
    promptWorkItemText: () =>
      Promise.resolve("Flaky login test\nFails one run in five."),
    createWorkItem: () => {
      calls.createWorkItem += 1;
      return Promise.resolve(CREATED_ITEM);
    },
    builderDirExists: () => true,
    scaffoldBuilderDir: () => undefined,
    dependenciesInstalled: () => true,
    installDependencies: () => Promise.resolve(),
    ensureRuntime: () => Promise.resolve(LAUNCHER),
    checkCredentials: () => Promise.resolve(OK_CREDENTIALS),
  };
  return { ports: { ...base, ...overrides }, calls };
}

function run(ports: DesignPreflightPorts, projectIdArgument = "project-from-arg") {
  return runDesignPreflight({
    baseUrl: BASE_URL,
    projectIdArgument,
    workItemIdArgument: undefined,
    reporter: noopBaseReporter,
    ports,
  });
}

describe("runDesignPreflight — free-text reference resolution", () => {
  test("resolves an id reference instead of creating", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemText: () =>
        Promise.resolve("0197f000-0000-7000-8000-000000000009"),
      getWorkItemById: (input) => {
        calls.getWorkItemById += 1;
        return input.workItemId === "0197f000-0000-7000-8000-000000000009"
          ? Promise.resolve(INGESTED_ITEM)
          : Promise.resolve(undefined);
      },
    });

    const result = await run(ports);

    expect(result.workItem).toEqual(INGESTED_ITEM);
    expect(calls.getWorkItemById).toBe(1);
    expect(calls.createWorkItem).toBe(0);
  });

  test("resolves a URL reference instead of creating", async () => {
    const url = "https://github.com/example/repo/issues/42";
    const { ports, calls } = createPorts({
      promptWorkItemText: () => Promise.resolve(url),
      findWorkItemByUrl: (input) => {
        calls.findWorkItemByUrl += 1;
        return input.url === url
          ? Promise.resolve(INGESTED_ITEM)
          : Promise.resolve(undefined);
      },
    });

    const result = await run(ports);

    expect(result.workItem).toEqual(INGESTED_ITEM);
    expect(calls.findWorkItemByUrl).toBe(1);
    expect(calls.createWorkItem).toBe(0);
  });

  test("an id reference that does not resolve falls through to create", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemText: () =>
        Promise.resolve("0197f000-0000-7000-8000-000000000099"),
    });

    const result = await run(ports);

    expect(calls.getWorkItemById).toBe(1);
    expect(calls.createWorkItem).toBe(1);
    expect(result.workItem).toEqual(CREATED_ITEM);
  });

  test("a URL reference that does not resolve falls through to create", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemText: () =>
        Promise.resolve("https://github.com/example/repo/issues/999"),
    });

    const result = await run(ports);

    expect(calls.findWorkItemByUrl).toBe(1);
    expect(calls.createWorkItem).toBe(1);
    expect(result.workItem).toEqual(CREATED_ITEM);
  });

  test("a reference lookup failure is tolerated and falls through to create", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemText: () =>
        Promise.resolve("0197f000-0000-7000-8000-000000000009"),
      getWorkItemById: () => Promise.reject(new Error("network down")),
    });

    const result = await run(ports);

    expect(calls.createWorkItem).toBe(1);
    expect(result.workItem).toEqual(CREATED_ITEM);
  });

  test("plain prose is never treated as a reference", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemText: () =>
        Promise.resolve("Fix the checkout bug from ticket #42"),
    });

    await run(ports);

    expect(calls.getWorkItemById).toBe(0);
    expect(calls.findWorkItemByUrl).toBe(0);
    expect(calls.createWorkItem).toBe(1);
  });
});
