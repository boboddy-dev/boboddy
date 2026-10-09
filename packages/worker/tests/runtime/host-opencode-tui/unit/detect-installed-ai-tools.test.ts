import { describe, expect, test } from "bun:test";
import { detectInstalledAiTools } from "../../../../src/runtime/host-opencode-tui/application/detect-installed-ai-tools";

/**
 * Installed-AI-tool detection coverage. Every case runs through the injected
 * `env`/`exists` ports against a fake path set; nothing touches the real
 * filesystem or the developer's shell environment.
 */

const HOME = "/home/dev";
const POSIX_PATH = "/usr/local/bin:/opt/homebrew/bin";

function envWithPath(pathValue: string) {
  return (name: string): string | undefined =>
    name === "PATH" ? pathValue : undefined;
}

function existsIn(paths: readonly string[]) {
  const present = new Set(paths);
  return (absolutePath: string): boolean => present.has(absolutePath);
}

describe("detectInstalledAiTools", () => {
  test.concurrent("returns nothing when no tool is installed", async () => {
    expect(
      await detectInstalledAiTools({
        homeDir: HOME,
        env: envWithPath(POSIX_PATH),
        platform: "darwin",
        exists: existsIn([]),
      }),
    ).toEqual([]);
  });

  test.concurrent("detects claude from a PATH binary alone", async () => {
    expect(
      await detectInstalledAiTools({
        homeDir: HOME,
        env: envWithPath(POSIX_PATH),
        platform: "darwin",
        exists: existsIn(["/opt/homebrew/bin/claude"]),
      }),
    ).toEqual(["claude"]);
  });

  test.concurrent("detects codex from its config directory alone", async () => {
    expect(
      await detectInstalledAiTools({
        homeDir: HOME,
        env: envWithPath(POSIX_PATH),
        platform: "linux",
        exists: existsIn([`${HOME}/.codex`]),
      }),
    ).toEqual(["codex"]);
  });

  test.concurrent(
    "reports copilot once when both config locations exist",
    async () => {
      expect(
        await detectInstalledAiTools({
          homeDir: HOME,
          env: envWithPath(POSIX_PATH),
          platform: "linux",
          exists: existsIn([
            `${HOME}/.config/github-copilot`,
            `${HOME}/.local/share/gh/extensions/gh-copilot`,
          ]),
        }),
      ).toEqual(["copilot"]);
    },
  );

  test.concurrent(
    "returns all tools sorted regardless of discovery order",
    async () => {
      expect(
        await detectInstalledAiTools({
          homeDir: HOME,
          env: envWithPath(POSIX_PATH),
          platform: "darwin",
          exists: existsIn([
            "/usr/local/bin/copilot",
            `${HOME}/.codex`,
            "/opt/homebrew/bin/claude",
          ]),
        }),
      ).toEqual(["claude", "codex", "copilot"]);
    },
  );

  test.concurrent("finds codex.exe on a win32 PATH", async () => {
    expect(
      await detectInstalledAiTools({
        homeDir: "C:\\Users\\dev",
        env: envWithPath("C:\\Windows\\System32;C:\\Tools\\bin"),
        platform: "win32",
        exists: existsIn(["C:\\Tools\\bin\\codex.exe"]),
      }),
    ).toEqual(["codex"]);
  });
});
