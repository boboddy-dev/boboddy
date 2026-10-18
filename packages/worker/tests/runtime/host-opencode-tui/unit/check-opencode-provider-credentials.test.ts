import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkOpencodeProviderCredentials } from "../../../../src/runtime/host-opencode-tui/application/check-opencode-provider-credentials";
import type {
  LoadOpencodeCredentialsInput,
  OpencodeCredential,
} from "../../../../src/runtime/runtime-service/infra/opencode-credential-source";

/**
 * Credential pre-flight coverage. Uses a temp HOME fixture with no provisioned
 * runtime (so no export runs) or an injected loader; nothing reads the
 * developer's real OpenCode credentials.
 *
 * Every assertion here is about provider NAMES and remediation text — no test
 * asserts on, or expects the code to surface, a token value.
 */

const LAUNCHER = "/Users/dev/.boboddy/runtimes/opencode/2.0.28/launch.sh";

/** An env that sees nothing, so the ambient shell cannot leak in. */
const emptyEnv: NodeJS.ProcessEnv = {};

async function writeAuthJson(
  homeDir: string,
  contents: Record<string, unknown>,
): Promise<void> {
  const authDir = path.join(homeDir, ".local", "share", "opencode");
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "auth.json"), JSON.stringify(contents));
}

describe("checkOpencodeProviderCredentials", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "opencode-cred-check-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("reports ok with provider names when auth.json has a credential", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "oauth", access: "oat-secret" },
    });

    const result = await checkOpencodeProviderCredentials({
      homeDir,
      env: emptyEnv,
    });

    expect(result).toEqual({ ok: true, providers: ["anthropic"] });
    expect(JSON.stringify(result)).not.toContain("oat-secret");
  });

  test("accepts a provider API key from the environment", async () => {
    const result = await checkOpencodeProviderCredentials({
      homeDir,
      env: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    });

    expect(result).toEqual({ ok: true, providers: ["anthropic"] });
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret");
  });

  test("ignores a blank env var", async () => {
    const result = await checkOpencodeProviderCredentials({
      homeDir,
      env: { ANTHROPIC_API_KEY: "   " },
    });

    expect(result.ok).toBe(false);
  });

  test("de-duplicates providers found in both auth.json and the env", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "api", key: "sk-a" },
    });

    const result = await checkOpencodeProviderCredentials({
      homeDir,
      env: { ANTHROPIC_API_KEY: "sk-a" },
    });

    expect(result).toEqual({ ok: true, providers: ["anthropic"] });
  });

  test("runs the export with the given launcher and reports its providers", async () => {
    const calls: LoadOpencodeCredentialsInput[] = [];
    const exported: OpencodeCredential[] = [
      {
        integrationID: "openai",
        source: "export",
        value: { type: "key", key: "sk-exported" },
      },
    ];

    const result = await checkOpencodeProviderCredentials({
      launcherPath: LAUNCHER,
      homeDir,
      env: emptyEnv,
      loadCredentials: (input) => {
        calls.push(input);
        return Promise.resolve(exported);
      },
    });

    expect(result).toEqual({ ok: true, providers: ["openai"] });
    expect(calls[0]?.launcherPath).toBe(LAUNCHER);
    expect(calls[0]?.homeDir).toBe(homeDir);
    expect(JSON.stringify(result)).not.toContain("sk-exported");
  });

  test("remediation points at the provisioned binary, quoted for spaces", async () => {
    const result = await checkOpencodeProviderCredentials({
      launcherPath: LAUNCHER,
      homeDir,
      env: emptyEnv,
      loadCredentials: () => Promise.resolve([]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a failed credential check");
    }
    expect(result.remediation).toContain(`"${LAUNCHER}" auth login`);
    expect(result.remediation).toContain("ANTHROPIC_API_KEY");
    // The user may not have opencode on PATH at all, so a bare `opencode`
    // invocation must not be suggested.
    expect(result.remediation).not.toMatch(/(^|\s)opencode auth login/u);
  });

  test("checks without provisioning a launcher first — `boboddy init` only", async () => {
    // `init` only needs the yes/no answer before deciding whether to launch
    // `opencode auth login` inline, so `launcherPath` is optional.
    const okResult = await checkOpencodeProviderCredentials({
      homeDir,
      env: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    });
    expect(okResult).toEqual({ ok: true, providers: ["anthropic"] });

    const missingResult = await checkOpencodeProviderCredentials({
      homeDir,
      env: emptyEnv,
    });
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) {
      throw new Error("expected a failed credential check");
    }
    expect(missingResult.remediation).toContain("opencode auth login");
  });
});
