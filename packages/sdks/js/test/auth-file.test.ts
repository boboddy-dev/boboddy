import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as authFile from "../src/defaults/auth-file";
import {
  getConfigFilePath,
  setTelemetryDisabled,
} from "../src/defaults/config-file";
import { setHomeDirForTests } from "../src/defaults/home-dir";

/**
 * `os.homedir()` is resolved by the runtime at ITS OWN startup — under Bun,
 * neither mutating `process.env.HOME` at runtime nor `mock.module("node:os",
 * ...)` changes what it returns afterward — so this suite uses
 * `setHomeDirForTests`, the one explicit, safe override hook shared by
 * `auth-file.ts` and `config-file.ts`. `afterEach` ALWAYS restores it to
 * `undefined` (the real `os.homedir()`), even if a test throws, so a bug
 * here can never silently start reading/writing a developer's actual
 * `~/.boboddy/` for the rest of the run.
 */

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "boboddy-auth-file-"));
  setHomeDirForTests(fakeHome);
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("auth profiles", () => {
  test("round-trips a saved profile at the new auth.jsonc path", () => {
    authFile.saveAuthProfile("https://example.test", {
      accessToken: "token-123",
      userId: "user-1",
    });

    expect(authFile.getAuthFilePath()).toContain(
      join(".boboddy", "auth.jsonc"),
    );
    expect(authFile.loadAuthProfile("https://example.test")).toEqual({
      accessToken: "token-123",
      userId: "user-1",
    });
  });

  test("returns null for an unknown baseUrl", () => {
    expect(authFile.loadAuthProfile("https://missing.test")).toBeNull();
  });

  test("supports multiple profiles keyed by baseUrl", () => {
    authFile.saveAuthProfile("https://a.test", { accessToken: "token-a" });
    authFile.saveAuthProfile("https://b.test", { accessToken: "token-b" });

    expect(authFile.loadAuthFile()).toEqual({
      profiles: {
        "https://a.test": { accessToken: "token-a" },
        "https://b.test": { accessToken: "token-b" },
      },
    });
  });
});

describe("deleteAuthProfile", () => {
  test("removes only the targeted profile when others remain", () => {
    authFile.saveAuthProfile("https://a.test", { accessToken: "token-a" });
    authFile.saveAuthProfile("https://b.test", { accessToken: "token-b" });

    authFile.deleteAuthProfile("https://a.test");

    expect(authFile.loadAuthFile()).toEqual({
      profiles: { "https://b.test": { accessToken: "token-b" } },
    });
  });

  test("removes auth.jsonc once no profiles remain", () => {
    authFile.saveAuthProfile("https://a.test", { accessToken: "token-a" });
    authFile.deleteAuthProfile("https://a.test");

    expect(existsSync(authFile.getAuthFilePath())).toBe(false);
  });

  test("leaves config.jsonc's telemetry settings untouched", () => {
    authFile.saveAuthProfile("https://a.test", { accessToken: "token-a" });
    setTelemetryDisabled(true);

    authFile.deleteAuthProfile("https://a.test");

    expect(existsSync(authFile.getAuthFilePath())).toBe(false);
    expect(existsSync(getConfigFilePath())).toBe(true);
  });

  test("is a no-op for a baseUrl with no saved profile", () => {
    authFile.saveAuthProfile("https://a.test", { accessToken: "token-a" });
    authFile.deleteAuthProfile("https://missing.test");

    expect(authFile.loadAuthFile()).toEqual({
      profiles: { "https://a.test": { accessToken: "token-a" } },
    });
  });
});

describe("JSONC tolerance", () => {
  test("loads a hand-edited auth.jsonc with comments and a trailing comma", () => {
    mkdirSync(dirname(authFile.getAuthFilePath()), { recursive: true });
    writeFileSync(
      authFile.getAuthFilePath(),
      [
        "{",
        "  // hand-edited for local testing",
        '  "profiles": {',
        '    "https://example.test": {',
        '      "accessToken": "token-123", // trailing comma below is fine too',
        "    },",
        "  },",
        "}",
      ].join("\n"),
      { encoding: "utf8" },
    );

    expect(authFile.loadAuthProfile("https://example.test")).toEqual({
      accessToken: "token-123",
    });
  });

  test("falls back to an empty file for genuinely malformed content", () => {
    mkdirSync(dirname(authFile.getAuthFilePath()), { recursive: true });
    writeFileSync(authFile.getAuthFilePath(), "{ not json", "utf8");

    expect(authFile.loadAuthFile()).toEqual({ profiles: {} });
  });
});

describe("real homedir is untouched", () => {
  test("setHomeDirForTests(undefined) resolves the path back to the real homedir", () => {
    setHomeDirForTests(undefined);
    expect(authFile.getAuthFilePath()).not.toContain(fakeHome);
    setHomeDirForTests(fakeHome); // restore for afterEach's own call
  });
});
