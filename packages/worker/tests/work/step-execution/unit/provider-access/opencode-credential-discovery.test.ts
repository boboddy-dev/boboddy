import { Writable } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { discoverOpencodeCredential } from "../../../../../src/work/step-execution/infra/provider-access/opencode-credential-discovery";

/** Build a pino logger that captures log lines into an array. */
function makeCapturingLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { logger: pino({ level: "warn" }, stream), lines };
}

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "opencode-discovery-"));
}

async function writeAuthJson(
  homeDir: string,
  contents: Record<string, unknown>,
): Promise<string> {
  const authDir = path.join(homeDir, ".local", "share", "opencode");
  await mkdir(authDir, { recursive: true });
  const authPath = path.join(authDir, "auth.json");
  await writeFile(authPath, JSON.stringify(contents));
  return authPath;
}

describe("discoverOpencodeCredential", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await makeHome();
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("discovers an api-key credential from auth.json", async () => {
    const authPath = await writeAuthJson(homeDir, {
      anthropic: { type: "api", key: "sk-test-123" },
    });

    const result = await discoverOpencodeCredential({ homeDir });

    expect(result).toBeDefined();
    expect(result?.providerId).toBe("anthropic");
    expect(result?.tokenValue).toBe("sk-test-123");
    expect(result?.tokenEnv).toBe("BOBODDY_PROVIDER_TOKEN");
    expect(result?.configFiles).toContain(authPath);
  });

  test("includes a discovered config file path when present", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "api", key: "sk-test-123" },
    });
    const configDir = path.join(homeDir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "opencode.json");
    await writeFile(configPath, "{}");

    const result = await discoverOpencodeCredential({ homeDir });

    expect(result?.configFiles).toContain(configPath);
  });

  test("returns undefined when auth.json is missing", async () => {
    const result = await discoverOpencodeCredential({ homeDir });
    expect(result).toBeUndefined();
  });

  test("returns undefined when provider entry is missing", async () => {
    await writeAuthJson(homeDir, {
      openai: { type: "api", key: "sk-other" },
    });

    const result = await discoverOpencodeCredential({ homeDir });
    expect(result).toBeUndefined();
  });

  test("discovers an oauth credential using the access token", async () => {
    const authPath = await writeAuthJson(homeDir, {
      anthropic: { type: "oauth", access: "oat-tok", refresh: "ort-ref", expires: 9999999999999 },
    });

    const result = await discoverOpencodeCredential({ homeDir });

    expect(result).toBeDefined();
    expect(result?.providerId).toBe("anthropic");
    expect(result?.tokenValue).toBe("oat-tok");
    expect(result?.tokenEnv).toBe("BOBODDY_PROVIDER_TOKEN");
    expect(result?.configFiles).toContain(authPath);
  });

  test("discovers an oauth credential without a refresh token", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "oauth", access: "oat-tok" },
    });

    const result = await discoverOpencodeCredential({ homeDir });

    expect(result?.tokenValue).toBe("oat-tok");
  });

  test("returns the credential and warns when the oauth entry is expired", async () => {
    const expiredAt = Date.now() - 1000;
    await writeAuthJson(homeDir, {
      anthropic: { type: "oauth", access: "oat-tok", refresh: "ort-ref", expires: expiredAt },
    });

    const { logger, lines } = makeCapturingLogger();
    const result = await discoverOpencodeCredential({ homeDir, logger });

    // Credential is still returned.
    expect(result).toBeDefined();
    expect(result?.tokenValue).toBe("oat-tok");

    // A warn-level line was emitted containing the provider id.
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.length).toBeGreaterThan(0);
    const firstLine = lines[0];
    expect(firstLine).toBeDefined();
    const parsed = JSON.parse(firstLine ?? "") as { level: number; msg: string };
    expect(parsed.level).toBe(40); // pino warn
    expect(parsed.msg).toContain("anthropic");
  });

  test("treats oauth entry with no expires field as non-expired (no warn)", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "oauth", access: "oat-tok" },
    });

    const { logger, lines } = makeCapturingLogger();
    const result = await discoverOpencodeCredential({ homeDir, logger });

    expect(result?.tokenValue).toBe("oat-tok");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.length).toBe(0);
  });

  test("treats oauth entry with expires=0 as non-expired (no warn)", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "oauth", access: "oat-tok", expires: 0 },
    });

    const { logger, lines } = makeCapturingLogger();
    const result = await discoverOpencodeCredential({ homeDir, logger });

    expect(result?.tokenValue).toBe("oat-tok");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.length).toBe(0);
  });

  test("returns undefined for oauth entry with empty access token", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "oauth", access: "", refresh: "ref" },
    });

    const result = await discoverOpencodeCredential({ homeDir });
    expect(result).toBeUndefined();
  });

  test("returns undefined for unrecognised entry types", async () => {
    await writeAuthJson(homeDir, {
      anthropic: { type: "unknown", token: "tok" },
    });

    const result = await discoverOpencodeCredential({ homeDir });
    expect(result).toBeUndefined();
  });

  test("returns undefined on unparseable auth.json", async () => {
    const authDir = path.join(homeDir, ".local", "share", "opencode");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, "auth.json"), "{ not json");

    const result = await discoverOpencodeCredential({ homeDir });
    expect(result).toBeUndefined();
  });

  test("respects an explicit provider id", async () => {
    await writeAuthJson(homeDir, {
      openai: { type: "api", key: "sk-openai" },
    });

    const result = await discoverOpencodeCredential({
      homeDir,
      providerId: "openai",
    });

    expect(result?.providerId).toBe("openai");
    expect(result?.tokenValue).toBe("sk-openai");
  });
});
