/**
 * Unit tests for {@link resolveGitCacheConfig}: pure env-map resolution of the
 * `BOBODDY_GIT_CACHE` switch and `BOBODDY_GIT_CACHE_DIR` location.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ConfigurationError } from "../../../../src/lib/errors";
import { resolveGitCacheConfig } from "../../../../src/runtime/runtime-service/infra/git-cache-config";

const HOME = "/home/tester";
const DEFAULT_DIR = path.join(HOME, ".boboddy", "git-cache");

describe("resolveGitCacheConfig", () => {
  test("unset gives on with the default dir under HOME", () => {
    expect(resolveGitCacheConfig({ HOME })).toEqual({
      enabled: true,
      cacheDir: DEFAULT_DIR,
    });
  });

  test("empty and whitespace-only values behave as unset", () => {
    for (const value of ["", "   "]) {
      expect(
        resolveGitCacheConfig({
          HOME,
          BOBODDY_GIT_CACHE: value,
          BOBODDY_GIT_CACHE_DIR: value,
        }),
      ).toEqual({ enabled: true, cacheDir: DEFAULT_DIR });
    }
  });

  test("explicit on is enabled", () => {
    expect(resolveGitCacheConfig({ HOME, BOBODDY_GIT_CACHE: "on" })).toEqual({
      enabled: true,
      cacheDir: DEFAULT_DIR,
    });
  });

  test("off disables the cache and exposes no dir", () => {
    expect(resolveGitCacheConfig({ HOME, BOBODDY_GIT_CACHE: "off" })).toEqual({
      enabled: false,
      cacheDir: null,
    });
  });

  test("the switch is case-insensitive and trimmed", () => {
    for (const value of ["ON", "On", "  on  ", "\ton\n"]) {
      expect(
        resolveGitCacheConfig({ HOME, BOBODDY_GIT_CACHE: value }).enabled,
      ).toBe(true);
    }
    for (const value of ["OFF", "Off", "  off  ", "\toff\n"]) {
      expect(
        resolveGitCacheConfig({ HOME, BOBODDY_GIT_CACHE: value }).enabled,
      ).toBe(false);
    }
  });

  test.each(["true", "false", "1", "0", "yes", "no", "disabled"])(
    "unknown BOBODDY_GIT_CACHE value %p throws",
    (value) => {
      expect(() =>
        resolveGitCacheConfig({ HOME, BOBODDY_GIT_CACHE: value }),
      ).toThrow(ConfigurationError);
    },
  );

  test("unknown value error names the variable and valid values", () => {
    expect(() =>
      resolveGitCacheConfig({ HOME, BOBODDY_GIT_CACHE: "maybe" }),
    ).toThrow(/BOBODDY_GIT_CACHE.*'on'.*'off'/);
  });

  test("honours an absolute BOBODDY_GIT_CACHE_DIR", () => {
    expect(
      resolveGitCacheConfig({
        HOME,
        BOBODDY_GIT_CACHE_DIR: "/var/cache/boboddy",
      }),
    ).toEqual({ enabled: true, cacheDir: "/var/cache/boboddy" });
  });

  test("trims BOBODDY_GIT_CACHE_DIR and drops a trailing slash", () => {
    expect(
      resolveGitCacheConfig({
        HOME,
        BOBODDY_GIT_CACHE_DIR: "  /var/cache/boboddy/  ",
      }).cacheDir,
    ).toBe("/var/cache/boboddy");
  });

  test.each(["relative/cache", "./cache", "../cache", "~/cache"])(
    "relative BOBODDY_GIT_CACHE_DIR %p throws",
    (dir) => {
      expect(() =>
        resolveGitCacheConfig({ HOME, BOBODDY_GIT_CACHE_DIR: dir }),
      ).toThrow(ConfigurationError);
    },
  );

  test("a relative dir is ignored when the cache is off", () => {
    expect(
      resolveGitCacheConfig({
        HOME,
        BOBODDY_GIT_CACHE: "off",
        BOBODDY_GIT_CACHE_DIR: "relative/cache",
      }),
    ).toEqual({ enabled: false, cacheDir: null });
  });

  test("an unknown switch value throws even when a dir is given", () => {
    expect(() =>
      resolveGitCacheConfig({
        HOME,
        BOBODDY_GIT_CACHE: "nope",
        BOBODDY_GIT_CACHE_DIR: "/var/cache/boboddy",
      }),
    ).toThrow(ConfigurationError);
  });

  test("default dir follows HOME from the supplied env, not process.env", () => {
    expect(resolveGitCacheConfig({ HOME: "/somewhere/else" }).cacheDir).toBe(
      path.join("/somewhere/else", ".boboddy", "git-cache"),
    );
  });
});
