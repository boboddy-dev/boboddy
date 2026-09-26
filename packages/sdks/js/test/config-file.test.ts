import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authFile from "../src/defaults/auth-file";
import * as configFile from "../src/defaults/config-file";
import { setHomeDirForTests } from "../src/defaults/home-dir";

/**
 * `getOrCreateAnonymousId`/`isTelemetryDisabled`/`setTelemetryDisabled`/
 * `getArtifactRetentionSettings` all read and write the SAME
 * `~/.boboddy/config.jsonc` file. See `auth-file.test.ts` for why this suite
 * uses `setHomeDirForTests` rather than mutating `process.env.HOME` or
 * mocking `node:os`. `afterEach` ALWAYS restores it to `undefined`, even if
 * a test throws.
 */

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "boboddy-config-file-"));
  setHomeDirForTests(fakeHome);
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("anonymous id", () => {
  test("creates and persists an id on first read", () => {
    const id = configFile.getOrCreateAnonymousId();
    expect(id.length).toBeGreaterThan(0);
    expect(configFile.loadConfigFile().anonymousId).toBe(id);
  });

  test("returns the same id on subsequent calls", () => {
    const first = configFile.getOrCreateAnonymousId();
    const second = configFile.getOrCreateAnonymousId();
    expect(second).toBe(first);
  });

  test("does not disturb auth profiles when creating an id", () => {
    authFile.saveAuthProfile("https://example.test", {
      accessToken: "token-123",
    });
    configFile.getOrCreateAnonymousId();
    expect(authFile.loadAuthFile()).toEqual({
      profiles: {
        "https://example.test": { accessToken: "token-123" },
      },
    });
  });
});

describe("telemetry opt-out flag", () => {
  test("defaults to not disabled", () => {
    expect(configFile.isTelemetryDisabled()).toBe(false);
  });

  test("setTelemetryDisabled(true) persists and is readable back", () => {
    configFile.setTelemetryDisabled(true);
    expect(configFile.isTelemetryDisabled()).toBe(true);
  });

  test("setTelemetryDisabled(false) clears the flag", () => {
    configFile.setTelemetryDisabled(true);
    configFile.setTelemetryDisabled(false);
    expect(configFile.isTelemetryDisabled()).toBe(false);
  });

  test("does not disturb the anonymous id or artifact defaults", () => {
    const id = configFile.getOrCreateAnonymousId();
    configFile.setTelemetryDisabled(true);
    expect(configFile.loadConfigFile()).toEqual({
      anonymousId: id,
      telemetryDisabled: true,
      artifacts: {
        localMaxBytes: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_BYTES,
        localMaxAgeDays: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_AGE_DAYS,
      },
    });
  });
});

describe("artifact retention settings", () => {
  test("defaults to 2 GiB / 14 days before the file exists", () => {
    expect(configFile.getArtifactRetentionSettings()).toEqual({
      localMaxBytes: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_BYTES,
      localMaxAgeDays: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_AGE_DAYS,
    });
  });

  test("defaults are populated in the file the moment it is first created", () => {
    configFile.setTelemetryDisabled(true);
    expect(configFile.loadConfigFile().artifacts).toEqual({
      localMaxBytes: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_BYTES,
      localMaxAgeDays: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_AGE_DAYS,
    });
  });

  test("round-trips custom values written directly to config.jsonc", () => {
    configFile.setTelemetryDisabled(true); // creates config.jsonc with defaults
    const before = configFile.loadConfigFile();
    const custom = {
      ...before,
      artifacts: { localMaxBytes: 1024, localMaxAgeDays: 3 },
    };
    writeFileSync(
      configFile.getConfigFilePath(),
      `${JSON.stringify(custom, null, 2)}\n`,
    );

    expect(configFile.getArtifactRetentionSettings()).toEqual({
      localMaxBytes: 1024,
      localMaxAgeDays: 3,
    });
  });
});

describe("real homedir is untouched", () => {
  test("setHomeDirForTests(undefined) resolves the path back to the real homedir", () => {
    setHomeDirForTests(undefined);
    expect(configFile.getConfigFilePath()).not.toContain(fakeHome);
    setHomeDirForTests(fakeHome); // restore for afterEach's own call
  });
});
