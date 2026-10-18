import {
  OPENCODE_RUNTIME_VERSION,
  type OpencodeProviderCredentialCheck,
} from "@boboddy/worker";
import {
  runDesignPreflight,
  type DesignPreflightPorts,
} from "../src/lib/design-preflight";
import type { DesignWorkItem } from "../src/lib/design-work-item";
import { noopBaseReporter } from "../src/lib/reporter-types";
import { fakeAgentToolsPorts } from "./design-agent-tools-fakes";

/**
 * Spy ports for `runDesignPreflight`: the "everything already set up" baseline,
 * with call counters so tests can assert which branches ran.
 */

export const BASE_URL = "https://app.example.com";
export const LAUNCHER = `/home/u/.boboddy/runtimes/opencode/${OPENCODE_RUNTIME_VERSION}/launch.sh`;
const OK_CREDENTIALS: OpencodeProviderCredentialCheck = {
  ok: true,
  providers: ["anthropic"],
};

export const INGESTED_ITEM: DesignWorkItem = {
  id: "0197f000-0000-7000-8000-000000000001",
  title: "Checkout 500s on submit",
  description: "Only on Safari 17.",
  platform: "github",
};

export const CREATED_ITEM: DesignWorkItem = {
  id: "0197f000-0000-7000-8000-000000000002",
  title: "Flaky login test",
  description: "Fails one run in five.",
  platform: "boboddy",
};

type Calls = {
  login: number;
  resolveProjectFromRepo: number;
  promptProject: number;
  resolveProjectRef: number;
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

/** The fake resolver's id for a ref, distinct from the ref so a mix-up shows. */
export const idOf = (ref: string) => `id-of-${ref}`;

export function createPorts(overrides: PortOverrides = {}): {
  ports: DesignPreflightPorts;
  calls: Calls;
} {
  const calls: Calls = {
    login: 0,
    resolveProjectFromRepo: 0,
    promptProject: 0,
    resolveProjectRef: 0,
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
    readConfiguredProject: () => Promise.resolve("project-from-config"),
    resolveProjectFromRepo: () => {
      calls.resolveProjectFromRepo += 1;
      return Promise.resolve("project-from-repo");
    },
    promptProject: () => {
      calls.promptProject += 1;
      return Promise.resolve("project-from-prompt");
    },
    resolveProjectRef: ({ ref }) => {
      calls.resolveProjectRef += 1;
      return Promise.resolve({ id: idOf(ref), owner: "acme", slug: ref });
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
    detectInstalledTools: () => Promise.resolve([]),
    runAuthLogin: () => Promise.reject(new Error("not expected")),
    ...fakeAgentToolsPorts(),
  };

  return { ports: { ...base, ...overrides }, calls };
}

/**
 * Await a rejection and hand back the error. Preferred over
 * `expect(...).rejects` here because it is genuinely awaited: these tests go on
 * to assert on side effects that must NOT have happened after the throw.
 */
export async function expectRejection(
  promise: Promise<unknown>,
): Promise<Error> {
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

export function run(
  ports: DesignPreflightPorts,
  projectArgument?: string,
  workItemIdArgument?: string,
) {
  return runDesignPreflight({
    baseUrl: BASE_URL,
    projectArgument,
    workItemIdArgument,
    reporter: noopBaseReporter,
    ports,
  });
}
