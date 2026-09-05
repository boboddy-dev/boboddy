/**
 * Single source of truth for the CLI's compiled-binary distribution targets.
 *
 * build.ts uses this to know what to compile; publish.ts uses it to know what
 * per-platform npm packages to publish (see the module doc in publish.ts for
 * why the CLI is split into a thin `@boboddy/cli` package plus one
 * `@boboddy/cli-<platform>-<arch>` optionalDependency per target).
 *
 * bin/boboddy and bin/postinstall.js (plain CommonJS scripts, not
 * compiled/bundled, so neither can import this `.ts` module at runtime) each
 * keep their own literal copies of the `platform:arch` → binary/package name
 * maps. If you add or rename a target here, update both files' `binaryNames`
 * and `platformPackageNames` maps to match.
 */

export interface CliBuildTarget {
  /** `bun build --compile --target=<bunTarget>` value. */
  readonly bunTarget: string;
  /** Compiled binary filename, e.g. `boboddy-darwin-arm64`. */
  readonly outputName: string;
  /** Node's `process.platform` value this target runs on. */
  readonly platform: "darwin" | "linux" | "win32";
  /** Node's `process.arch` value this target runs on. */
  readonly arch: "arm64" | "x64";
  /** Published optionalDependency package name for this target. */
  readonly packageName: string;
  /** Whether the compiled binary needs ad-hoc codesigning (macOS only). */
  readonly codesign?: boolean;
}

export const CLI_NAME = "boboddy";

export const CLI_BUILD_TARGETS: readonly CliBuildTarget[] = [
  {
    bunTarget: "bun-darwin-arm64",
    outputName: `${CLI_NAME}-darwin-arm64`,
    platform: "darwin",
    arch: "arm64",
    packageName: "@boboddy/cli-darwin-arm64",
    codesign: true,
  },
  {
    bunTarget: "bun-darwin-x64",
    outputName: `${CLI_NAME}-darwin-x64`,
    platform: "darwin",
    arch: "x64",
    packageName: "@boboddy/cli-darwin-x64",
    codesign: true,
  },
  {
    bunTarget: "bun-linux-x64",
    outputName: `${CLI_NAME}-linux-x64`,
    platform: "linux",
    arch: "x64",
    packageName: "@boboddy/cli-linux-x64",
  },
  {
    bunTarget: "bun-linux-arm64",
    outputName: `${CLI_NAME}-linux-arm64`,
    platform: "linux",
    arch: "arm64",
    packageName: "@boboddy/cli-linux-arm64",
  },
  {
    bunTarget: "bun-windows-x64",
    outputName: `${CLI_NAME}-windows-x64.exe`,
    platform: "win32",
    arch: "x64",
    packageName: "@boboddy/cli-win32-x64",
  },
];
