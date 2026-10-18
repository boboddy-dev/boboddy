import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  loadOpencodeCredentials,
  opencodeCredentialSecrets,
  parseAuthExport,
  readEnvCredentials,
  readLegacyAuthJson,
  type RunExportInput,
} from "../../../../src/runtime/runtime-service/infra/opencode-credential-source";
import { SecretMasker } from "../../../../src/work/task/application/secret-masker";

/**
 * Credential source coverage. Every case uses a temp HOME and an injected
 * export runner; nothing runs a real `auth export` or reads the developer's
 * real OpenCode credentials.
 */

const EXPORT_OUTPUT = JSON.stringify([
  {
    integrationID: "anthropic",
    active: true,
    value: { type: "key", key: "sk-export-anthropic" },
  },
  {
    integrationID: "openai",
    active: true,
    value: {
      type: "oauth",
      methodID: "chatgpt",
      access: "at-export-openai",
      refresh: "rt-export-openai",
      expires: 1_900_000_000_000,
    },
  },
  {
    integrationID: "inactive",
    active: false,
    value: { type: "key", key: "sk-inactive" },
  },
  {
    integrationID: "machine-bound",
    value: { type: "external", reference: "keychain" },
  },
]);

async function writeAuthJson(
  homeDir: string,
  contents: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(homeDir, ".local", "share", "opencode");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "auth.json"), JSON.stringify(contents));
}

describe("parseAuthExport", () => {
  test("keeps active key and OAuth credentials and drops the rest", () => {
    expect(parseAuthExport(EXPORT_OUTPUT)).toEqual([
      {
        integrationID: "anthropic",
        source: "export",
        value: { type: "key", key: "sk-export-anthropic" },
      },
      {
        integrationID: "openai",
        source: "export",
        value: {
          type: "oauth",
          methodID: "chatgpt",
          access: "at-export-openai",
          refresh: "rt-export-openai",
          expires: 1_900_000_000_000,
        },
      },
    ]);
  });

  test("rejects output that is not a JSON array", () => {
    expect(() => parseAuthExport("{}")).toThrow("JSON array");
    expect(() => parseAuthExport("not json")).toThrow(SyntaxError);
  });
});

describe("readLegacyAuthJson", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "opencode-cred-source-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("translates api, wellknown and oauth entries the way OpenCode imports them", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "api", key: "sk-a" },
      "https://example.com/": { type: "wellknown", token: "wk" },
      openai: { type: "oauth", access: "at", refresh: "rt", expires: 5 },
      "github-copilot": { type: "oauth", access: "gh" },
      broken: { type: "oauth", access: "" },
      unknown: { type: "wat" },
    });

    const credentials = await readLegacyAuthJson({ HOME: homeDir });

    expect(credentials).toEqual([
      {
        integrationID: "anthropic",
        source: "auth.json",
        value: { type: "key", key: "sk-a" },
      },
      {
        integrationID: "https://example.com",
        source: "auth.json",
        value: { type: "key", key: "wk" },
      },
      {
        integrationID: "openai",
        source: "auth.json",
        value: {
          type: "oauth",
          methodID: "chatgpt-browser",
          access: "at",
          refresh: "rt",
          expires: 5,
        },
      },
      {
        integrationID: "github-copilot",
        source: "auth.json",
        value: {
          type: "oauth",
          methodID: "device",
          access: "gh",
          refresh: "",
          expires: 0,
        },
      },
    ]);
  });

  test("honors XDG_DATA_HOME and tolerates a missing or broken file", async () => {
    const dataHome = path.join(homeDir, "data");
    expect(
      await readLegacyAuthJson({ HOME: homeDir, XDG_DATA_HOME: dataHome }),
    ).toEqual([]);

    await mkdir(path.join(dataHome, "opencode"), { recursive: true });
    await writeFile(path.join(dataHome, "opencode", "auth.json"), "{ nope");
    expect(
      await readLegacyAuthJson({ HOME: homeDir, XDG_DATA_HOME: dataHome }),
    ).toEqual([]);
  });
});

describe("readEnvCredentials", () => {
  test("maps provider API-key vars to integrations, first set var wins, blanks ignored", () => {
    expect(
      readEnvCredentials({
        ANTHROPIC_API_KEY: "   ",
        GEMINI_API_KEY: "gem-1",
        GOOGLE_GENERATIVE_AI_API_KEY: "gem-2",
        OPENAI_API_KEY: "sk-o",
      }),
    ).toEqual([
      {
        integrationID: "openai",
        source: "env",
        value: { type: "key", key: "sk-o" },
      },
      {
        integrationID: "google",
        source: "env",
        value: { type: "key", key: "gem-1" },
      },
    ]);
  });
});

describe("loadOpencodeCredentials", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "opencode-cred-source-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("merges per integration: export beats auth.json beats env", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "api", key: "sk-legacy-anthropic" },
      groq: { type: "api", key: "sk-legacy-groq" },
    });

    const credentials = await loadOpencodeCredentials({
      launcherPath: "/runtime/launch.sh",
      homeDir,
      env: {
        ANTHROPIC_API_KEY: "sk-env-anthropic",
        GROQ_API_KEY: "sk-env-groq",
        XAI_API_KEY: "sk-env-xai",
      },
      runExport: () => Promise.resolve(EXPORT_OUTPUT),
    });

    expect(
      credentials.map(({ integrationID, source }) => [integrationID, source]),
    ).toEqual([
      ["anthropic", "export"],
      ["groq", "auth.json"],
      ["openai", "export"],
      ["xai", "env"],
    ]);
  });

  test("runs the export with an isolated env when the home is overridden", async () => {
    const calls: RunExportInput[] = [];

    await loadOpencodeCredentials({
      launcherPath: "/runtime/launch.sh",
      homeDir,
      env: {
        PATH: "/usr/bin",
        XDG_DATA_HOME: "/real/user/data",
        ANTHROPIC_API_KEY: "sk-env",
      },
      runExport: (input) => {
        calls.push(input);
        return Promise.resolve("[]");
      },
    });

    expect(calls).toEqual([
      {
        launcherPath: "/runtime/launch.sh",
        env: { HOME: homeDir, PATH: "/usr/bin" },
      },
    ]);
  });

  test("skips the export when launcherPath is null", async () => {
    let exported = false;

    const credentials = await loadOpencodeCredentials({
      launcherPath: null,
      homeDir,
      env: { OPENAI_API_KEY: "sk-env" },
      runExport: () => {
        exported = true;
        return Promise.resolve(EXPORT_OUTPUT);
      },
    });

    expect(exported).toBe(false);
    expect(credentials.map(({ source }) => source)).toEqual(["env"]);
  });

  test("falls back to auth.json on export failure with a warning that carries no output", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "api", key: "sk-legacy" },
    });
    const warnings: string[] = [];

    const credentials = await loadOpencodeCredentials({
      launcherPath: "/runtime/launch.sh",
      homeDir,
      env: {},
      onWarning: (message) => warnings.push(message),
      runExport: () =>
        Promise.resolve('[{"integrationID":"x","value":{"key":"sk-leak'),
    });

    expect(credentials.map(({ source }) => source)).toEqual(["auth.json"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("output was not valid JSON");
    expect(warnings[0]).not.toContain("sk-leak");
  });
});

describe("opencodeCredentialSecrets", () => {
  test("lists every secret so the masker hides keys and both OAuth tokens", () => {
    const credentials = parseAuthExport(EXPORT_OUTPUT);
    const masker = new SecretMasker(opencodeCredentialSecrets(credentials));

    expect(opencodeCredentialSecrets(credentials)).toEqual([
      "sk-export-anthropic",
      "at-export-openai",
      "rt-export-openai",
    ]);
    expect(
      masker.mask(
        "key=sk-export-anthropic at=at-export-openai rt=rt-export-openai",
      ),
    ).toBe("key=*** at=*** rt=***");
  });
});
