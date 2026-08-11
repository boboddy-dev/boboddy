import { describe, expect, test } from "bun:test";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import {
  NO_WORK_ITEM_MESSAGE,
  runDesignPreflight,
  type DesignPreflightPorts,
} from "../src/lib/design-preflight";
import {
  FREE_TEXT_WORK_ITEM,
  SEARCH_WORK_ITEM,
  type DesignWorkItem,
} from "../src/lib/design-work-item";
import { noopBaseReporter } from "../src/lib/reporter-types";

/**
 * The picker's search rung: the recent-items window is not viable for a
 * project with many synced items, so this re-queries the server with a
 * keyword and loops back into the picker with the results. Split from
 * `design-preflight.test.ts` (which covers every other precondition) purely
 * to stay under this repo's per-file line budget.
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

function createPorts(overrides: Partial<DesignPreflightPorts> = {}) {
  const calls = {
    listWorkItems: 0,
    promptWorkItemChoice: 0,
    promptWorkItemSearch: 0,
  };
  const base: DesignPreflightPorts = {
    loadSession: () => Promise.resolve({ email: "user@example.com" }),
    login: () => Promise.resolve({ email: "user@example.com" }),
    readConfiguredProjectId: () => Promise.resolve("project-from-config"),
    resolveProjectFromRepo: () => Promise.resolve("project-from-repo"),
    promptProjectId: () => Promise.resolve(undefined),
    listWorkItems: (input) => {
      calls.listWorkItems += 1;
      return Promise.resolve(input.query === undefined ? [INGESTED_ITEM] : []);
    },
    getWorkItemById: () => Promise.resolve(undefined),
    findWorkItemByUrl: () => Promise.resolve(undefined),
    promptWorkItemChoice: () => {
      calls.promptWorkItemChoice += 1;
      return Promise.resolve(INGESTED_ITEM);
    },
    promptWorkItemSearch: () => {
      calls.promptWorkItemSearch += 1;
      return Promise.resolve(undefined);
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
  projectIdArgument = "project-from-arg",
) {
  return runDesignPreflight({
    baseUrl: BASE_URL,
    projectIdArgument,
    workItemIdArgument: undefined,
    reporter: noopBaseReporter,
    ports,
  });
}

describe("runDesignPreflight — search rung", () => {
  test("re-queries and loops back into the picker", async () => {
    const searchResult: DesignWorkItem = {
      ...INGESTED_ITEM,
      id: "0197f000-0000-7000-8000-000000000003",
    };
    const searchResults = [searchResult];
    const { ports, calls } = createPorts({
      promptWorkItemChoice: () => {
        calls.promptWorkItemChoice += 1;
        // First call sees the initial list and takes the search rung; the
        // second call sees the search results and picks from them.
        return Promise.resolve(
          calls.promptWorkItemChoice === 1 ? SEARCH_WORK_ITEM : searchResult,
        );
      },
      promptWorkItemSearch: () => {
        calls.promptWorkItemSearch += 1;
        return Promise.resolve("flaky");
      },
      listWorkItems: (input) => {
        calls.listWorkItems += 1;
        return Promise.resolve(
          input.query === undefined ? [INGESTED_ITEM] : searchResults,
        );
      },
    });

    const result = await run(ports);

    expect(calls.promptWorkItemSearch).toBe(1);
    expect(calls.listWorkItems).toBe(2);
    expect(calls.promptWorkItemChoice).toBe(2);
    expect(result.workItem).toEqual(searchResult);
  });

  test("passes the search keyword through to listWorkItems", async () => {
    let seenQuery: string | undefined;
    let choiceCalls = 0;
    const { ports } = createPorts({
      promptWorkItemChoice: () => {
        choiceCalls += 1;
        // Search once, then cancel — otherwise an empty result loops forever.
        return Promise.resolve(
          choiceCalls === 1 ? SEARCH_WORK_ITEM : undefined,
        );
      },
      promptWorkItemSearch: () => Promise.resolve("checkout bug"),
      listWorkItems: (input) => {
        seenQuery = input.query;
        return Promise.resolve(
          input.query === undefined ? [INGESTED_ITEM] : [],
        );
      },
    });

    await expectRejection(run(ports));

    expect(seenQuery).toBe("checkout bug");
  });

  test("cancelling the search prompt cancels the whole picker", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemChoice: () => Promise.resolve(SEARCH_WORK_ITEM),
      promptWorkItemSearch: () => Promise.resolve(undefined),
    });

    const error = await expectRejection(run(ports));

    expect(error.message).toBe(NO_WORK_ITEM_MESSAGE);
    expect(calls.listWorkItems).toBe(1);
  });

  test("an empty search result still offers the picker again, not a hard stop", async () => {
    const { ports, calls } = createPorts({
      promptWorkItemChoice: () => {
        calls.promptWorkItemChoice += 1;
        // The second call sees zero item rungs (no matches) but is still a
        // real picker prompt — the user takes the free-text rung from it.
        return Promise.resolve(
          calls.promptWorkItemChoice === 1
            ? SEARCH_WORK_ITEM
            : FREE_TEXT_WORK_ITEM,
        );
      },
      promptWorkItemSearch: () => Promise.resolve("nothing matches this"),
      promptWorkItemText: () => Promise.resolve("Fix the flaky login test"),
      listWorkItems: (input) => {
        calls.listWorkItems += 1;
        return Promise.resolve(
          input.query === undefined ? [INGESTED_ITEM] : [],
        );
      },
      createWorkItem: () =>
        Promise.resolve({ ...INGESTED_ITEM, id: "created-id" }),
    });

    const result = await run(ports);

    expect(calls.listWorkItems).toBe(2);
    expect(calls.promptWorkItemChoice).toBe(2);
    expect(result.workItem.id).toBe("created-id");
  });
});
