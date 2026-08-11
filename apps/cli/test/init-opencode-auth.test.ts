import { describe, expect, test } from "bun:test";
import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import {
  AUTH_LOGIN_DID_NOT_COMPLETE_MESSAGE,
  ensureOpencodeAuth,
  type InitOpencodeAuthPorts,
} from "../src/lib/init-opencode-auth";
import { noopBaseReporter } from "../src/lib/reporter-types";

/**
 * `boboddy init`'s OpenCode-auth gate. Every port is a spy — no network, no
 * filesystem, no real subprocess.
 *
 * The one thing every test here confirms: with a credential already present
 * (auth.json OR a recognized env var — see
 * `check-opencode-provider-credentials.test.ts` for that detection logic),
 * `init` never touches the runtime or spawns a login, matching
 * `pipelines design`'s preflight.
 */

const OK: OpencodeProviderCredentialCheck = {
  ok: true,
  providers: ["anthropic"],
};
const MISSING: OpencodeProviderCredentialCheck = {
  ok: false,
  remediation: "opencode auth login",
};

type Calls = { ensureRuntime: number; runAuthLogin: string[] };

function createPorts(overrides: {
  checkCredentials?: () => Promise<OpencodeProviderCredentialCheck>;
}): { ports: InitOpencodeAuthPorts; calls: Calls } {
  const calls: Calls = { ensureRuntime: 0, runAuthLogin: [] };
  const ports: InitOpencodeAuthPorts = {
    checkCredentials: overrides.checkCredentials ?? (() => Promise.resolve(OK)),
    ensureRuntime: () => {
      calls.ensureRuntime += 1;
      return Promise.resolve(
        "/home/u/.boboddy/runtimes/opencode/1.18.11/launch.sh",
      );
    },
    runAuthLogin: (launcherPath) => {
      calls.runAuthLogin.push(launcherPath);
      return Promise.resolve();
    },
  };
  return { ports, calls };
}

describe("ensureOpencodeAuth", () => {
  test("does nothing when a credential is already found", async () => {
    const { ports, calls } = createPorts({
      checkCredentials: () => Promise.resolve(OK),
    });

    await ensureOpencodeAuth({ reporter: noopBaseReporter, ports });

    expect(calls.ensureRuntime).toBe(0);
    expect(calls.runAuthLogin).toEqual([]);
  });

  test("passes when only a recognized env var is set, no config file", async () => {
    // Mirrors `pipelines design`'s preflight: env-var-only credentials pass
    // without ever reaching the runtime/login path.
    const { ports, calls } = createPorts({
      checkCredentials: () =>
        Promise.resolve({ ok: true, providers: ["anthropic"] }),
    });

    await ensureOpencodeAuth({ reporter: noopBaseReporter, ports });

    expect(calls.ensureRuntime).toBe(0);
    expect(calls.runAuthLogin).toEqual([]);
  });

  test("provisions the runtime and runs `opencode auth login` inline when nothing is found", async () => {
    let checkCount = 0;
    const { ports, calls } = createPorts({
      checkCredentials: () => {
        checkCount += 1;
        // Missing on the first check, present after the login runs.
        return Promise.resolve(checkCount === 1 ? MISSING : OK);
      },
    });

    await ensureOpencodeAuth({ reporter: noopBaseReporter, ports });

    expect(calls.ensureRuntime).toBe(1);
    expect(calls.runAuthLogin).toEqual([
      "/home/u/.boboddy/runtimes/opencode/1.18.11/launch.sh",
    ]);
  });

  test("throws when the login runs but still no credential shows up", async () => {
    const { ports } = createPorts({
      checkCredentials: () => Promise.resolve(MISSING),
    });

    let thrown: Error | undefined;
    try {
      await ensureOpencodeAuth({ reporter: noopBaseReporter, ports });
    } catch (error) {
      thrown = error instanceof Error ? error : undefined;
    }

    expect(thrown?.message).toBe(AUTH_LOGIN_DID_NOT_COMPLETE_MESSAGE);
  });

  test("propagates a runtime provisioning failure without running login", async () => {
    const { ports, calls } = createPorts({
      checkCredentials: () => Promise.resolve(MISSING),
    });
    const failingPorts: InitOpencodeAuthPorts = {
      ...ports,
      ensureRuntime: () => Promise.reject(new Error("socket hang up")),
    };

    let thrown: Error | undefined;
    try {
      await ensureOpencodeAuth({
        reporter: noopBaseReporter,
        ports: failingPorts,
      });
    } catch (error) {
      thrown = error instanceof Error ? error : undefined;
    }

    expect(thrown?.message).toBe("socket hang up");
    expect(calls.runAuthLogin).toEqual([]);
  });
});
