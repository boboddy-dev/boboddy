import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authFile from "../src/defaults/auth-file";
import * as configFile from "../src/defaults/config-file";
import { setHomeDirForTests } from "../src/defaults/home-dir";

/**
 * Exercises `migrateLegacyConfigIfNeeded` indirectly through `loadAuthFile()`
 * and `loadConfigFile()` — the only two entrypoints that trigger it (decision
 * 6: whichever loads first performs the split). See `auth-file.test.ts` for
 * why this suite uses `setHomeDirForTests` rather than mutating
 * `process.env.HOME` or mocking `node:os`. `afterEach` ALWAYS restores it to
 * `undefined`, even if a test throws.
 */

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "boboddy-legacy-migration-"));
  setHomeDirForTests(fakeHome);
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

const legacyJsonPath = () => join(fakeHome, ".boboddy.json");
const legacyBarePath = () => join(fakeHome, ".boboddy");

const LEGACY_MERGED_FILE = {
  profiles: {
    "https://example.test": {
      accessToken: "token-123",
      email: "user@example.test",
    },
  },
  anonymousId: "anon-abc-123",
  telemetryDisabled: true,
};

function writeLegacyJsonFile(): void {
  writeFileSync(
    legacyJsonPath(),
    `${JSON.stringify(LEGACY_MERGED_FILE, null, 2)}\n`,
    "utf8",
  );
}

function writeLegacyBareFile(): void {
  writeFileSync(
    legacyBarePath(),
    `${JSON.stringify(LEGACY_MERGED_FILE, null, 2)}\n`,
    "utf8",
  );
}

function assertSplitCorrectly(): void {
  expect(existsSync(authFile.getAuthFilePath())).toBe(true);
  expect(existsSync(configFile.getConfigFilePath())).toBe(true);

  expect(authFile.loadAuthFile()).toEqual({
    profiles: LEGACY_MERGED_FILE.profiles,
  });
  expect(configFile.loadConfigFile()).toEqual({
    anonymousId: LEGACY_MERGED_FILE.anonymousId,
    telemetryDisabled: LEGACY_MERGED_FILE.telemetryDisabled,
    artifacts: {
      localMaxBytes: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_BYTES,
      localMaxAgeDays: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_AGE_DAYS,
    },
  });

  expect(existsSync(legacyJsonPath())).toBe(false);
  // `.boboddy` (the bare legacy path) is also the new `.boboddy/` directory
  // that `auth.jsonc`/`config.jsonc` live under, so it's expected to exist as
  // a directory after the split — only assert the legacy *file* is gone.
  if (existsSync(legacyBarePath())) {
    expect(lstatSync(legacyBarePath()).isFile()).toBe(false);
  }
}

describe("migrating a legacy .boboddy.json", () => {
  test("loadAuthFile() splits it into auth.jsonc + config.jsonc with artifact defaults", () => {
    writeLegacyJsonFile();

    authFile.loadAuthFile();

    assertSplitCorrectly();
  });

  test("loadConfigFile() splits it into auth.jsonc + config.jsonc with artifact defaults", () => {
    writeLegacyJsonFile();

    configFile.loadConfigFile();

    assertSplitCorrectly();
  });
});

describe("migrating a legacy bare .boboddy file", () => {
  /**
   * Regression case: the bare `.boboddy` legacy path is the exact same path
   * as the new `.boboddy/` directory that `auth.jsonc`/`config.jsonc` live
   * under, so the legacy file must be removed BEFORE the new files are
   * written (see the matching comment in `legacy-config-migration.ts`) —
   * otherwise writing collides with the still-present legacy file (`ENOTDIR`).
   */
  test("loadAuthFile() splits it into auth.jsonc + config.jsonc with artifact defaults", () => {
    writeLegacyBareFile();

    authFile.loadAuthFile();

    assertSplitCorrectly();
  });

  test("loadConfigFile() splits it into auth.jsonc + config.jsonc with artifact defaults", () => {
    writeLegacyBareFile();

    configFile.loadConfigFile();

    assertSplitCorrectly();
  });
});

describe("idempotency", () => {
  test("a second loadAuthFile() call after migration does not re-migrate or alter the split files", () => {
    writeLegacyJsonFile();

    authFile.loadAuthFile();
    const authContentAfterFirst = readFileSync(
      authFile.getAuthFilePath(),
      "utf8",
    );
    const configContentAfterFirst = readFileSync(
      configFile.getConfigFilePath(),
      "utf8",
    );

    authFile.loadAuthFile();

    expect(readFileSync(authFile.getAuthFilePath(), "utf8")).toBe(
      authContentAfterFirst,
    );
    expect(readFileSync(configFile.getConfigFilePath(), "utf8")).toBe(
      configContentAfterFirst,
    );
    assertSplitCorrectly();
  });

  test("a second loadConfigFile() call after migration does not re-migrate or alter the split files", () => {
    writeLegacyJsonFile();

    configFile.loadConfigFile();
    const authContentAfterFirst = readFileSync(
      authFile.getAuthFilePath(),
      "utf8",
    );
    const configContentAfterFirst = readFileSync(
      configFile.getConfigFilePath(),
      "utf8",
    );

    configFile.loadConfigFile();

    expect(readFileSync(authFile.getAuthFilePath(), "utf8")).toBe(
      authContentAfterFirst,
    );
    expect(readFileSync(configFile.getConfigFilePath(), "utf8")).toBe(
      configContentAfterFirst,
    );
    assertSplitCorrectly();
  });

  test("calling loadAuthFile() then loadConfigFile() does not double-migrate", () => {
    writeLegacyJsonFile();

    authFile.loadAuthFile();
    configFile.loadConfigFile();

    assertSplitCorrectly();
  });
});

describe("fresh machine (no legacy file, no new files)", () => {
  test("loadAuthFile() returns empty profiles without crashing", () => {
    expect(authFile.loadAuthFile()).toEqual({ profiles: {} });
    expect(existsSync(authFile.getAuthFilePath())).toBe(false);
  });

  test("loadConfigFile() returns defaults without crashing", () => {
    expect(configFile.loadConfigFile()).toEqual({
      artifacts: {
        localMaxBytes: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_BYTES,
        localMaxAgeDays: configFile.DEFAULT_ARTIFACT_LOCAL_MAX_AGE_DAYS,
      },
    });
    expect(existsSync(configFile.getConfigFilePath())).toBe(false);
  });
});
