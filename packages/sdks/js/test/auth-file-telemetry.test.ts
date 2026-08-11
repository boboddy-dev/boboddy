import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authFile from "../src/defaults/auth-file";

/**
 * `getOrCreateAnonymousId`/`isTelemetryDisabled`/`setTelemetryDisabled` all
 * read and write the SAME `~/.boboddy.json` file `loadAuthProfile`/
 * `saveAuthProfile` do. `os.homedir()` is resolved by the runtime at ITS OWN
 * startup — under Bun, neither mutating `process.env.HOME` at runtime nor
 * `mock.module("node:os", ...)` changes what it returns afterward — so this
 * suite uses `setHomeDirForTests`, the module's one explicit, safe override
 * hook, rather than either of those. `afterEach` ALWAYS restores it to
 * `undefined` (the real `os.homedir()`), even if a test throws, so a bug
 * here can never silently start reading/writing a developer's actual
 * `~/.boboddy.json` for the rest of the run.
 */

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "boboddy-auth-file-telemetry-"));
  authFile.setHomeDirForTests(fakeHome);
});

afterEach(() => {
  authFile.setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("anonymous id", () => {
  test("creates and persists an id on first read", () => {
    const id = authFile.getOrCreateAnonymousId();
    expect(id.length).toBeGreaterThan(0);
    expect(authFile.loadAuthFile().anonymousId).toBe(id);
  });

  test("returns the same id on subsequent calls", () => {
    const first = authFile.getOrCreateAnonymousId();
    const second = authFile.getOrCreateAnonymousId();
    expect(second).toBe(first);
  });

  test("preserves existing profiles when creating an id", () => {
    authFile.saveAuthProfile("https://example.test", {
      accessToken: "token-123",
    });
    const id = authFile.getOrCreateAnonymousId();
    expect(authFile.loadAuthFile()).toEqual({
      profiles: {
        "https://example.test": { accessToken: "token-123" },
      },
      anonymousId: id,
    });
  });
});

describe("telemetry opt-out flag", () => {
  test("defaults to not disabled", () => {
    expect(authFile.isTelemetryDisabled()).toBe(false);
  });

  test("setTelemetryDisabled(true) persists and is readable back", () => {
    authFile.setTelemetryDisabled(true);
    expect(authFile.isTelemetryDisabled()).toBe(true);
  });

  test("setTelemetryDisabled(false) clears the flag", () => {
    authFile.setTelemetryDisabled(true);
    authFile.setTelemetryDisabled(false);
    expect(authFile.isTelemetryDisabled()).toBe(false);
  });

  test("does not disturb profiles or the anonymous id", () => {
    authFile.saveAuthProfile("https://example.test", {
      accessToken: "token-456",
    });
    const id = authFile.getOrCreateAnonymousId();
    authFile.setTelemetryDisabled(true);
    expect(authFile.loadAuthFile()).toEqual({
      profiles: {
        "https://example.test": { accessToken: "token-456" },
      },
      anonymousId: id,
      telemetryDisabled: true,
    });
  });
});

describe("real homedir is untouched", () => {
  test("setHomeDirForTests(undefined) resolves the path back to the real homedir", () => {
    authFile.setHomeDirForTests(undefined);
    expect(authFile.getAuthFilePath()).not.toContain(fakeHome);
    authFile.setHomeDirForTests(fakeHome); // restore for afterEach's own call
  });
});
