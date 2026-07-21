/**
 * Unit tests for the pure {@link parseSubmoduleStatus} parser. No git is run;
 * these exercise the exact textual shapes `git submodule status` emits.
 */
import { describe, expect, test } from "bun:test";
import { parseSubmoduleStatus } from "../../../../src/runtime/runtime-service/domain/submodules";

const SHA = "abcabcabcabcabcabcabcabcabcabcabcabcabca";

describe("parseSubmoduleStatus", () => {
  test("returns [] for empty input", () => {
    expect(parseSubmoduleStatus("")).toEqual([]);
  });

  test("returns [] for whitespace-only input", () => {
    expect(parseSubmoduleStatus("   \n\t\n")).toEqual([]);
  });

  test("parses an uninitialized submodule (`-`) as initialized:false", () => {
    expect(parseSubmoduleStatus(`-${SHA} libs/foo\n`)).toEqual([
      { path: "libs/foo", initialized: false },
    ]);
  });

  test("parses a clean submodule (leading space) as initialized:true", () => {
    expect(
      parseSubmoduleStatus(` ${SHA} libs/foo (heads/main)\n`),
    ).toEqual([{ path: "libs/foo", initialized: true }]);
  });

  test("parses a modified submodule (`+`) as initialized:true", () => {
    expect(
      parseSubmoduleStatus(`+${SHA} libs/foo (v1.0.0-2-gabc)\n`),
    ).toEqual([{ path: "libs/foo", initialized: true }]);
  });

  test("parses a conflicted submodule (`U`) as initialized:true", () => {
    expect(parseSubmoduleStatus(`U${SHA} libs/foo\n`)).toEqual([
      { path: "libs/foo", initialized: true },
    ]);
  });

  test("handles lines with and without the trailing (describe)", () => {
    const stdout = ` ${SHA} with/desc (heads/main)\n+${SHA} no/desc\n`;
    expect(parseSubmoduleStatus(stdout)).toEqual([
      { path: "with/desc", initialized: true },
      { path: "no/desc", initialized: true },
    ]);
  });

  test("parses multiple submodules with mixed statuses", () => {
    const stdout = [
      `-${SHA} vendor/uninit`,
      ` ${SHA} vendor/clean (heads/main)`,
      `+${SHA} vendor/dirty (v2)`,
      "",
    ].join("\n");
    expect(parseSubmoduleStatus(stdout)).toEqual([
      { path: "vendor/uninit", initialized: false },
      { path: "vendor/clean", initialized: true },
      { path: "vendor/dirty", initialized: true },
    ]);
  });
});
