import { describe, expect, test } from "bun:test";
import {
  buildDevcontainerCliCommand,
  parseDevcontainerProgress,
  resolveDevcontainerCliScriptPath,
} from "../../../../src/runtime/runtime-service/infra/devcontainer-cli-launcher";

describe("devcontainer CLI launcher", () => {
  test.concurrent("invokes the devcontainer bundle using the current executable", () => {
    expect(
      buildDevcontainerCliCommand("/tmp/devcontainer.js", ["up", "--help"]),
    ).toEqual([process.execPath, "/tmp/devcontainer.js", "up", "--help"]);
  });

  test.concurrent("resolves script path from BOBODDY_DEVCONTAINER_SCRIPT env var when set", () => {
    const original = process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
    process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = "/custom/path/devcontainer.js";
    try {
      expect(resolveDevcontainerCliScriptPath()).toBe("/custom/path/devcontainer.js");
    } finally {
      if (original === undefined) {
        delete process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
      } else {
        process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = original;
      }
    }
  });
});

describe("parseDevcontainerProgress", () => {
  test.concurrent("maps a lifecycle `start` line to a milestone", () => {
    const line = JSON.stringify({
      type: "start",
      level: 2,
      timestamp: 1700000000000,
      text: "Running the postCreateCommand from devcontainer.json...",
    });
    expect(parseDevcontainerProgress(line)).toEqual({
      kind: "milestone",
      phase: "Running the postCreateCommand from devcontainer.json...",
    });
  });

  test.concurrent("maps a low-level `Run:` start to a detail line", () => {
    const line = JSON.stringify({
      type: "start",
      level: 2,
      text: "Run: docker ps -q -a --filter label=devcontainer.local_folder=/x",
    });
    expect(parseDevcontainerProgress(line)).toEqual({
      kind: "detail",
      phase: "Run: docker ps -q -a --filter label=devcontainer.local_folder=/x",
    });
  });

  test.concurrent("maps a running `progress` line to a milestone", () => {
    const line = JSON.stringify({
      type: "progress",
      name: "Installing Dotfiles",
      status: "running",
    });
    expect(parseDevcontainerProgress(line)).toEqual({
      kind: "milestone",
      phase: "Installing Dotfiles",
    });
  });

  test.concurrent("drops `text`/`raw` output lines (too noisy / multi-line)", () => {
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "text", level: 3, text: "npm install noise\n" }),
      ),
    ).toBeNull();
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "raw", level: 3, text: "raw bytes" }),
      ),
    ).toBeNull();
  });

  test.concurrent("collapses multi-line / padded `start` text to a single line", () => {
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "start", text: "Run: foo\n  bar\tbaz  " }),
      ),
    ).toEqual({ kind: "detail", phase: "Run: foo bar baz" });
  });

  test.concurrent("ignores non-running progress and empty/blank labels", () => {
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "progress", name: "X", status: "succeeded" }),
      ),
    ).toBeNull();
    expect(
      parseDevcontainerProgress(JSON.stringify({ type: "start", text: "   " })),
    ).toBeNull();
    expect(
      parseDevcontainerProgress(JSON.stringify({ type: "text", text: "  \n" })),
    ).toBeNull();
  });

  test.concurrent("ignores non-JSON and non-object lines", () => {
    expect(parseDevcontainerProgress("")).toBeNull();
    expect(parseDevcontainerProgress("plain text log")).toBeNull();
    expect(parseDevcontainerProgress("{not valid json")).toBeNull();
    expect(parseDevcontainerProgress("null")).toBeNull();
    expect(parseDevcontainerProgress("[1,2,3]")).toBeNull();
  });
});
