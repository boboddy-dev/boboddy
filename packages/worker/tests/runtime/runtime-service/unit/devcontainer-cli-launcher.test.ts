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
    // Must point at a real file: resolveDevcontainerCliScriptPath() verifies
    // existence (see the "throws when the configured script path does not
    // exist" test below), so this file itself stands in for the bundle.
    process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = import.meta.path;
    try {
      expect(resolveDevcontainerCliScriptPath()).toBe(import.meta.path);
    } finally {
      if (original === undefined) {
        delete process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
      } else {
        process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = original;
      }
    }
  });

  test.concurrent("throws a clear, actionable error when BOBODDY_DEVCONTAINER_SCRIPT is unset", () => {
    const original = process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
    delete process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
    try {
      expect(() => resolveDevcontainerCliScriptPath()).toThrow(
        /BOBODDY_DEVCONTAINER_SCRIPT is not set/u,
      );
    } finally {
      if (original !== undefined) {
        process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = original;
      }
    }
  });

  test.concurrent("throws a clear, actionable error when the configured script path does not exist", () => {
    // Regression test: a corrupted/partial npm install (e.g. an interrupted
    // extraction) can leave BOBODDY_DEVCONTAINER_SCRIPT pointing at a path
    // that was never written. Previously this surfaced 8+ seconds later as an
    // opaque "devcontainer CLI exited with a non-zero exit code" deep inside
    // a worker run; it must now fail immediately with the missing path and a
    // reinstall suggestion.
    const original = process.env["BOBODDY_DEVCONTAINER_SCRIPT"];
    process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = "/nonexistent/devcontainer.js";
    try {
      expect(() => resolveDevcontainerCliScriptPath()).toThrow(
        /Devcontainer CLI bundle not found.*\/nonexistent\/devcontainer\.js.*npm install -g @boboddy\/cli/su,
      );
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
    expect(parseDevcontainerProgress(line)).toEqual([
      {
        kind: "milestone",
        phase: "Running the postCreateCommand from devcontainer.json...",
        level: "info",
      },
    ]);
  });

  test.concurrent("maps a low-level `Run:` start to a detail line", () => {
    const line = JSON.stringify({
      type: "start",
      level: 2,
      text: "Run: docker ps -q -a --filter label=devcontainer.local_folder=/x",
    });
    expect(parseDevcontainerProgress(line)).toEqual([
      {
        kind: "detail",
        phase: "Run: docker ps -q -a --filter label=devcontainer.local_folder=/x",
        level: "info",
      },
    ]);
  });

  test.concurrent("maps a running `progress` line to a milestone", () => {
    const line = JSON.stringify({
      type: "progress",
      name: "Installing Dotfiles",
      status: "running",
    });
    expect(parseDevcontainerProgress(line)).toEqual([
      { kind: "milestone", phase: "Installing Dotfiles", level: "info" },
    ]);
  });

  test.concurrent("surfaces a multi-line `text`/`raw` payload as one detail", () => {
    // One CLI event is one idea: the whole payload ships as a single line,
    // preserving internal newlines (only trailing whitespace is trimmed).
    expect(
      parseDevcontainerProgress(
        JSON.stringify({
          type: "text",
          level: 3,
          text: "npm install noise\nsecond line\n",
        }),
      ),
    ).toEqual([
      {
        kind: "detail",
        phase: "npm install noise\nsecond line",
        level: "info",
      },
    ]);
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "raw", level: 3, text: "raw bytes" }),
      ),
    ).toEqual([{ kind: "detail", phase: "raw bytes", level: "info" }]);
  });

  test.concurrent("maps the CLI LogLevel to a severity (error/warn/info)", () => {
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "text", level: 5, text: "init.sh: command failed" }),
      ),
    ).toEqual([
      { kind: "detail", phase: "init.sh: command failed", level: "error" },
    ]);
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "text", level: 4, text: "deprecation warning" }),
      ),
    ).toEqual([{ kind: "detail", phase: "deprecation warning", level: "warn" }]);
  });

  test.concurrent("maps a `stop` line to a detail", () => {
    expect(
      parseDevcontainerProgress(
        JSON.stringify({
          type: "stop",
          level: 2,
          text: "Run: docker build",
          startTimestamp: 1,
        }),
      ),
    ).toEqual([
      { kind: "detail", phase: "Run: docker build", level: "info" },
    ]);
  });

  test.concurrent("collapses multi-line / padded `start` text to a single line", () => {
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "start", text: "Run: foo\n  bar\tbaz  " }),
      ),
    ).toEqual([{ kind: "detail", phase: "Run: foo bar baz", level: "info" }]);
  });

  test.concurrent("ignores non-running progress and empty/blank labels", () => {
    expect(
      parseDevcontainerProgress(
        JSON.stringify({ type: "progress", name: "X", status: "succeeded" }),
      ),
    ).toEqual([]);
    expect(
      parseDevcontainerProgress(JSON.stringify({ type: "start", text: "   " })),
    ).toEqual([]);
    expect(
      parseDevcontainerProgress(JSON.stringify({ type: "text", text: "  \n" })),
    ).toEqual([]);
  });

  test.concurrent("ignores non-JSON and non-object lines", () => {
    expect(parseDevcontainerProgress("")).toEqual([]);
    expect(parseDevcontainerProgress("plain text log")).toEqual([]);
    expect(parseDevcontainerProgress("{not valid json")).toEqual([]);
    expect(parseDevcontainerProgress("null")).toEqual([]);
    expect(parseDevcontainerProgress("[1,2,3]")).toEqual([]);
  });
});
