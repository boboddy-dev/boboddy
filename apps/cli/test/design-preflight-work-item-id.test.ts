import { describe, expect, test } from "bun:test";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import {
  runDesignPreflight,
  workItemNotFoundMessage,
  type DesignPreflightPorts,
} from "../src/lib/design-preflight";
import type { DesignWorkItem } from "../src/lib/design-work-item";
import { noopBaseReporter } from "../src/lib/reporter-types";

/**
 * `--work-item-id`'s one job: reach an item older than the picker's recent
 * window without paging through it. Split from `design-preflight.test.ts`
 * (which covers every other precondition) purely to stay under this repo's
 * per-file line budget.
 */

const BASE_URL = "https://app.example.com";
const LAUNCHER = "/home/u/.boboddy/runtimes/opencode/1.18.11/launch.sh";
const OK_CREDENTIALS: OpencodeProviderCredentialCheck = {
  ok: true,
  providers: ["anthropic"],
};

const RECENT_ITEM: DesignWorkItem = {
  id: "0197f000-0000-7000-8000-000000000001",
  title: "Checkout 500s on submit",
  description: "Only on Safari 17.",
  platform: "github",
};

const OLDER_ITEM: DesignWorkItem = {
  id: "0197f000-0000-7000-8000-000000000009",
  title: "Old ticket from three months ago",
  description: "Older than the picker's recent window.",
  platform: "jira",
};

function createPorts(overrides: Partial<DesignPreflightPorts> = {}) {
  const calls = {
    listWorkItems: 0,
    getWorkItemById: 0,
    promptWorkItemChoice: 0,
  };
  const base: DesignPreflightPorts = {
    loadSession: () => Promise.resolve({ email: "user@example.com" }),
    login: () => Promise.resolve({ email: "user@example.com" }),
    readConfiguredProjectId: () => Promise.resolve("project-from-config"),
    resolveProjectFromRepo: () => Promise.resolve("project-from-repo"),
    promptProjectId: () => Promise.resolve(undefined),
    listWorkItems: () => {
      calls.listWorkItems += 1;
      return Promise.resolve([RECENT_ITEM]);
    },
    getWorkItemById: () => {
      calls.getWorkItemById += 1;
      return Promise.resolve(undefined);
    },
    promptWorkItemChoice: () => {
      calls.promptWorkItemChoice += 1;
      return Promise.resolve(RECENT_ITEM);
    },
    promptWorkItemText: () => Promise.resolve(undefined),
    createWorkItem: () => Promise.reject(new Error("not expected")),
    builderDirExists: () => true,
    scaffoldBuilderDir: () => undefined,
    dependenciesInstalled: () => true,
    installDependencies: () => Promise.resolve(),
    ensureRuntime: () => Promise.resolve(LAUNCHER),
    checkCredentials: () => Promise.resolve(OK_CREDENTIALS),
  };
  return { ports: { ...base, ...overrides }, calls };
}

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
  workItemIdArgument: string | undefined,
  projectIdArgument = "project-from-arg",
) {
  return runDesignPreflight({
    baseUrl: BASE_URL,
    projectIdArgument,
    workItemIdArgument,
    reporter: noopBaseReporter,
    ports,
  });
}

describe("runDesignPreflight — --work-item-id", () => {
  test("wins outright over the picker, and skips it entirely", async () => {
    const { ports, calls } = createPorts({
      getWorkItemById: () => {
        calls.getWorkItemById += 1;
        return Promise.resolve(OLDER_ITEM);
      },
    });

    const result = await run(ports, OLDER_ITEM.id);

    expect(result.workItem).toEqual(OLDER_ITEM);
    expect(calls.getWorkItemById).toBe(1);
    expect(calls.listWorkItems).toBe(0);
    expect(calls.promptWorkItemChoice).toBe(0);
  });

  test("looks the item up against the resolved project", async () => {
    let seen:
      { baseUrl: string; projectId: string; workItemId: string } | undefined;
    const { ports } = createPorts({
      getWorkItemById: (input) => {
        seen = input;
        return Promise.resolve(OLDER_ITEM);
      },
    });

    await run(ports, OLDER_ITEM.id, "project-from-arg");

    expect(seen).toEqual({
      baseUrl: BASE_URL,
      projectId: "project-from-arg",
      workItemId: OLDER_ITEM.id,
    });
  });

  test("treats whitespace-only as absent and falls back to the picker", async () => {
    const { ports, calls } = createPorts();

    const result = await run(ports, "   ");

    expect(result.workItem).toEqual(RECENT_ITEM);
    expect(calls.getWorkItemById).toBe(0);
    expect(calls.promptWorkItemChoice).toBe(1);
  });

  test("a miss is a hard stop, not a silent fall-through to the picker", async () => {
    const { ports, calls } = createPorts({
      getWorkItemById: () => Promise.resolve(undefined),
    });

    const error = await expectRejection(run(ports, "missing-id"));

    expect(error.message).toBe(
      workItemNotFoundMessage("missing-id", "project-from-arg"),
    );
    expect(calls.promptWorkItemChoice).toBe(0);
  });

  test("a lookup failure surfaces its own error rather than falling back", async () => {
    const { ports, calls } = createPorts({
      getWorkItemById: () => Promise.reject(new Error("network down")),
    });

    const error = await expectRejection(run(ports, OLDER_ITEM.id));

    expect(error.message).toBe("network down");
    expect(calls.promptWorkItemChoice).toBe(0);
  });
});
