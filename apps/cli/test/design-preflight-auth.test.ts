import { describe, expect, test } from "bun:test";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import {
  runDesignPreflight,
  type DesignPreflightPorts,
} from "../src/lib/design-preflight";
import type { DesignWorkItem } from "../src/lib/design-work-item";
import { noopBaseReporter } from "../src/lib/reporter-types";

/**
 * Step 1 of the preflight — signing in. Split from `design-preflight.test.ts`
 * (which covers every other precondition) purely to stay under this repo's
 * per-file line budget.
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
  const calls = { login: 0 };
  const base: DesignPreflightPorts = {
    loadSession: () => Promise.resolve({ email: "user@example.com" }),
    login: () => {
      calls.login += 1;
      return Promise.resolve({ email: "fresh@example.com" });
    },
    readConfiguredProjectId: () => Promise.resolve("project-from-config"),
    resolveProjectFromRepo: () => Promise.resolve("project-from-repo"),
    promptProjectId: () => Promise.resolve("project-from-prompt"),
    listWorkItems: () => Promise.resolve([INGESTED_ITEM]),
    getWorkItemById: () => Promise.resolve(undefined),
    findWorkItemByUrl: () => Promise.resolve(undefined),
    promptWorkItemChoice: () => Promise.resolve(INGESTED_ITEM),
    promptWorkItemSearch: () => Promise.resolve(undefined),
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

function run(ports: DesignPreflightPorts) {
  return runDesignPreflight({
    baseUrl: BASE_URL,
    projectIdArgument: undefined,
    workItemIdArgument: undefined,
    reporter: noopBaseReporter,
    ports,
  });
}

describe("runDesignPreflight — auth", () => {
  test("signs in inline when there is no session", async () => {
    const { ports, calls } = createPorts({
      loadSession: () => Promise.resolve(null),
    });

    await run(ports);

    expect(calls.login).toBe(1);
  });

  test("does not sign in when a session already exists", async () => {
    const { ports, calls } = createPorts();

    await run(ports);

    expect(calls.login).toBe(0);
  });
});
