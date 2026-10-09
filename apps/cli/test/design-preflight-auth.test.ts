import { describe, expect, test } from "bun:test";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import {
  runDesignPreflight,
  type DesignPreflightPorts,
} from "../src/lib/design-preflight";
import type { DesignWorkItem } from "../src/lib/design-work-item";
import { noopBaseReporter } from "../src/lib/reporter-types";

/**
 * The preflight's two auth steps — signing in to Boboddy and connecting an AI
 * provider. Split from `design-preflight.test.ts` (which covers every other
 * precondition) purely to stay under this repo's per-file line budget.
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
    detectInstalledTools: () => Promise.resolve([]),
    runAuthLogin: () => Promise.reject(new Error("not expected")),
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

  test("signs in inline when the stored token is no longer valid", async () => {
    const { ports, calls } = createPorts({
      loadSession: () => Promise.reject(new Error("401 Unauthorized")),
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

describe("runDesignPreflight — AI provider", () => {
  test("heals a missing credential by running auth login against the launcher", async () => {
    let checks = 0;
    const logins: string[] = [];
    const { ports } = createPorts({
      checkCredentials: () => {
        checks += 1;
        return Promise.resolve(
          checks === 1
            ? { ok: false, remediation: "opencode auth login" }
            : { ok: true, providers: ["openai"] },
        );
      },
      runAuthLogin: (launcherPath) => {
        logins.push(launcherPath);
        return Promise.resolve();
      },
    });

    const result = await run(ports);

    expect(logins).toEqual([LAUNCHER]);
    expect(result.providers).toEqual(["openai"]);
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
