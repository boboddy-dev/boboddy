import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkOpencodeProviderCredentials } from "../../../../src/runtime/host-opencode-tui/application/check-opencode-provider-credentials";
import { listOpencodeAuthProviders } from "../../../../src/work/step-execution/infra/provider-access/opencode-credential-discovery";

/**
 * Credential pre-flight coverage. Uses a temp HOME fixture; nothing reads the
 * developer's real `~/.local/share/opencode/auth.json`.
 *
 * Every assertion here is about provider NAMES and remediation text — no test
 * asserts on, or expects the code to surface, a token value.
 */

const LAUNCHER = "/Users/dev/.boboddy/runtimes/opencode/1.18.11/launch.sh";

/** Env source that sees nothing, so the ambient shell cannot leak in. */
const emptyEnv = (): string | undefined => undefined;

async function writeAuthJson(
  homeDir: string,
  contents: Record<string, unknown>,
): Promise<void> {
  const authDir = path.join(homeDir, ".local", "share", "opencode");
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "auth.json"), JSON.stringify(contents));
}

describe("listOpencodeAuthProviders", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "opencode-cred-check-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("returns sorted provider names for api and oauth entries", async () => {
    await writeAuthJson(homeDir, {
      openai: { type: "api", key: "sk-openai" },
      anthropic: { type: "oauth", access: "oat" },
    });

    expect(await listOpencodeAuthProviders({ homeDir })).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  test("skips unrecognised and empty entries", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "api", key: "sk-a" },
      broken: { type: "wat" },
      emptyOauth: { type: "oauth", access: "" },
    });

    expect(await listOpencodeAuthProviders({ homeDir })).toEqual(["anthropic"]);
  });

  test("returns an empty list when auth.json is missing or unparseable", async () => {
    expect(await listOpencodeAuthProviders({ homeDir })).toEqual([]);

    const authDir = path.join(homeDir, ".local", "share", "opencode");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, "auth.json"), "{ not json");

    expect(await listOpencodeAuthProviders({ homeDir })).toEqual([]);
  });
});

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
      launcherPath: LAUNCHER,
      homeDir,
      env: emptyEnv,
    });

    expect(result).toEqual({ ok: true, providers: ["anthropic"] });
    // Belt and braces: the token value must never appear in the result.
    expect(JSON.stringify(result)).not.toContain("oat-secret");
  });

  test("accepts a provider API key from the environment", async () => {
    const result = await checkOpencodeProviderCredentials({
      launcherPath: LAUNCHER,
      homeDir,
      env: (name) =>
        name === "ANTHROPIC_API_KEY" ? "sk-ant-secret" : undefined,
    });

    expect(result).toEqual({ ok: true, providers: ["anthropic"] });
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret");
  });

  test("ignores a blank env var", async () => {
    const result = await checkOpencodeProviderCredentials({
      launcherPath: LAUNCHER,
      homeDir,
      env: (name) => (name === "ANTHROPIC_API_KEY" ? "   " : undefined),
    });

    expect(result.ok).toBe(false);
  });

  test("de-duplicates providers found in both auth.json and the env", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "api", key: "sk-a" },
    });

    const result = await checkOpencodeProviderCredentials({
      launcherPath: LAUNCHER,
      homeDir,
      env: (name) => (name === "ANTHROPIC_API_KEY" ? "sk-a" : undefined),
    });

    expect(result).toEqual({ ok: true, providers: ["anthropic"] });
  });

  test("remediation points at the provisioned binary, quoted for spaces", async () => {
    const result = await checkOpencodeProviderCredentials({
      launcherPath: LAUNCHER,
      homeDir,
      env: emptyEnv,
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
});
