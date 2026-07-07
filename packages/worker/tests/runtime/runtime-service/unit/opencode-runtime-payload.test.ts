import { describe, expect, test } from "bun:test";
import {
  LINUX_PAYLOAD_PLATFORMS,
  OPENCODE_RUNTIME_VERSION,
  OPENCODE_RUNTIME_VERSION_ENV,
  containerLaunchWrapperPath,
  containerOpencodeRuntimeVersionDir,
  hostOpencodeRuntimeVersionDir,
  opencodePlatformPackage,
  resolveHostHome,
  resolveHostNativePlatform,
  resolveOpencodeRuntimeVersion,
} from "../../../../src/runtime/runtime-service/domain/opencode-runtime-payload";
import { resolveDefaultPayloadPlatforms } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { buildOpencodeLaunchWrapper } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-launch-wrapper";

describe("opencode runtime payload domain", () => {
  test("resolves the pinned version by default", () => {
    expect(resolveOpencodeRuntimeVersion(() => undefined)).toBe(
      OPENCODE_RUNTIME_VERSION,
    );
  });

  test("env override wins for the version", () => {
    const env = (name: string): string | undefined =>
      name === OPENCODE_RUNTIME_VERSION_ENV ? "9.9.9" : undefined;
    expect(resolveOpencodeRuntimeVersion(env)).toBe("9.9.9");
  });

  test("host + container payload paths are version-keyed", () => {
    expect(hostOpencodeRuntimeVersionDir("/home/u", "1.2.3")).toBe(
      "/home/u/.boboddy/runtimes/opencode/1.2.3",
    );
    expect(containerOpencodeRuntimeVersionDir("1.2.3")).toBe(
      "/opt/boboddy/runtimes/opencode/1.2.3",
    );
    expect(containerLaunchWrapperPath("1.2.3")).toBe(
      "/opt/boboddy/runtimes/opencode/1.2.3/launch.sh",
    );
  });

  test("HOME env override is honored", () => {
    expect(resolveHostHome((name) => (name === "HOME" ? "/tmp/h" : undefined))).toBe(
      "/tmp/h",
    );
  });

  test("platform package names map to opencode npm packages", () => {
    expect(opencodePlatformPackage("linux-arm64")).toBe("opencode-linux-arm64");
    expect(opencodePlatformPackage("linux-x64-musl")).toBe(
      "opencode-linux-x64-musl",
    );
  });

  test("always provisions glibc + musl variants for both arches (Linux set)", () => {
    expect([...LINUX_PAYLOAD_PLATFORMS]).toEqual([
      "linux-arm64",
      "linux-x64",
      "linux-arm64-musl",
      "linux-x64-musl",
    ]);
  });

  test("resolves the host-native platform per OS/arch", () => {
    expect(resolveHostNativePlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(resolveHostNativePlatform("darwin", "x64")).toBe("darwin-x64");
    // Linux hosts reuse the glibc Linux binary already in the Linux set.
    expect(resolveHostNativePlatform("linux", "x64")).toBe("linux-x64");
    // Unsupported OS / arch => no host-native binary.
    expect(resolveHostNativePlatform("win32", "x64")).toBeNull();
    expect(resolveHostNativePlatform("linux", "ia32")).toBeNull();
  });

  test("darwin host adds its native binary on top of the Linux set", () => {
    expect([...resolveDefaultPayloadPlatforms("darwin-arm64")]).toEqual([
      "linux-arm64",
      "linux-x64",
      "linux-arm64-musl",
      "linux-x64-musl",
      "darwin-arm64",
    ]);
  });

  test("linux host provisions only the Linux set (no extra binary)", () => {
    expect([...resolveDefaultPayloadPlatforms("linux-x64")]).toEqual([
      ...LINUX_PAYLOAD_PLATFORMS,
    ]);
  });

  test("unsupported host provisions only the Linux set", () => {
    expect([...resolveDefaultPayloadPlatforms(null)]).toEqual([
      ...LINUX_PAYLOAD_PLATFORMS,
    ]);
  });

  test("darwin platform package names map to opencode npm packages", () => {
    expect(opencodePlatformPackage("darwin-arm64")).toBe("opencode-darwin-arm64");
  });
});

describe("opencode launch wrapper", () => {
  const wrapper = buildOpencodeLaunchWrapper();

  test("is a POSIX sh script that execs the selected binary", () => {
    expect(wrapper.startsWith("#!/bin/sh")).toBe(true);
    expect(wrapper).toContain('exec "$candidate" "$@"');
  });

  test("detects arch via uname and libc via alpine-release / ldd", () => {
    expect(wrapper).toContain("uname -m");
    expect(wrapper).toContain("/etc/alpine-release");
    expect(wrapper).toContain("ldd --version");
  });

  test("detects the OS via uname -s and selects the darwin binary on macOS", () => {
    expect(wrapper).toContain("uname -s");
    expect(wrapper).toContain('"$os" = "Darwin"');
    expect(wrapper).toContain('BIN_ROOT/darwin-${arch}/opencode');
  });

  test("resolves binaries relative to its own dir (mount-path agnostic)", () => {
    expect(wrapper).toContain('SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")"');
    expect(wrapper).toContain('BIN_ROOT="$SCRIPT_DIR/bin"');
  });
});
