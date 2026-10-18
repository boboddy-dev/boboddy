/**
 * Unit tests for {@link OpencodeLogLineClassifier}: severity for OpenCode 2.x
 * structured `key=value` serve-log lines, the keyword fallback for unstructured
 * output, continuation inheritance, ANSI stripping, and the promotion of
 * configuration normalization diagnostics. Fixture lines are taken from a real
 * `opencode serve --print-logs --log-level info` log, with paths neutralised.
 */
import { describe, expect, test } from "bun:test";
import {
  OpencodeLogLineClassifier,
  stripAnsi,
} from "../../../../src/work/task/application/opencode-log-line-classifier";

const structured = (level: string, rest: string): string =>
  `timestamp=2026-10-14T00:16:33.686Z level=${level} run=2e4438a2 ${rest} role=server`;

const INFO_LINE = structured(
  "INFO",
  'message="watcher started" path=/home/agent/ws type=entries backend=node ignores=0 http.span=113',
);
const OVERLAY_DIAGNOSTIC = structured(
  "WARN",
  'message="configuration normalization diagnostic" source=OPENCODE_CONFIG_CONTENT path=$.model kind=invalid action="skipped malformed recognized value" http.span=354',
);
const GLOBAL_DIAGNOSTIC = structured(
  "WARN",
  'message="configuration normalization diagnostic" source=/home/agent/.config/opencode/opencode.json path=$ kind=invalid action="rejected malformed JSON or JSONC document" http.span=100',
);

describe("OpencodeLogLineClassifier", () => {
  test.each([
    ["TRACE", "debug"],
    ["DEBUG", "debug"],
    ["INFO", "debug"],
    ["WARN", "warn"],
    ["ERROR", "error"],
    ["FATAL", "error"],
  ] as const)("maps level=%s to %s", (level, expected) => {
    const line = structured(level, 'message="something happened"');
    expect(new OpencodeLogLineClassifier().classify(line)).toEqual({
      content: line,
      level: expected,
    });
  });

  test("uses level= even when the message text contains error keywords", () => {
    const line = structured("INFO", 'message="retrying after error" attempt=2');
    expect(new OpencodeLogLineClassifier().classify(line).level).toBe("debug");
  });

  test("keeps a real INFO line at debug so it stays out of the default feed", () => {
    expect(new OpencodeLogLineClassifier().classify(INFO_LINE).level).toBe(
      "debug",
    );
  });

  test("strips ANSI escapes before classifying and from the shipped content", () => {
    const classifier = new OpencodeLogLineClassifier();
    expect(
      classifier.classify(
        `\u001b[33m${structured("WARN", 'message="slow"')}\u001b[0m`,
      ),
    ).toEqual({
      content: structured("WARN", 'message="slow"'),
      level: "warn",
    });
    expect(classifier.classify("\u001b[31mError:\u001b[0m boom")).toEqual({
      content: "Error: boom",
      level: "error",
    });
    expect(stripAnsi("\u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe(
      "link",
    );
  });

  describe("unstructured lines", () => {
    test("ships the launch wrapper's boboddy: messages at warn or above", () => {
      const classifier = new OpencodeLogLineClassifier();
      expect(
        classifier.classify(
          "boboddy: Alpine images need 'apk add libstdc++ libgcc' for OpenCode",
        ).level,
      ).toBe("warn");
      expect(
        classifier.classify(
          "boboddy: no OpenCode binary for linux-arm64-musl in /opt/bin",
        ).level,
      ).toBe("warn");
      expect(
        classifier.classify("boboddy: fatal: payload is corrupt").level,
      ).toBe("error");
    });

    test("treats unmarked output before any structured line as debug", () => {
      expect(
        new OpencodeLogLineClassifier().classify(
          "server listening on http://127.0.0.1:52774",
        ).level,
      ).toBe("debug");
    });

    test("continuation lines inherit the previous structured level", () => {
      const classifier = new OpencodeLogLineClassifier();
      classifier.classify(structured("ERROR", 'message="cli process failed"'));
      expect(
        classifier.classify("    at runEffect (src/cli.ts:12:3)").level,
      ).toBe("error");
      expect(classifier.classify("    at main (src/index.ts:4:1)").level).toBe(
        "error",
      );

      classifier.classify(INFO_LINE);
      expect(classifier.classify("  }").level).toBe("debug");
    });

    test("a keyword marker overrides the inherited level", () => {
      const classifier = new OpencodeLogLineClassifier();
      classifier.classify(structured("WARN", 'message="slow"'));
      expect(classifier.classify("Unhandled rejection: boom").level).toBe(
        "error",
      );
    });

    test("blank lines are always debug", () => {
      const classifier = new OpencodeLogLineClassifier();
      classifier.classify(structured("ERROR", 'message="boom"'));
      expect(classifier.classify("").level).toBe("debug");
    });
  });

  describe("configuration diagnostics", () => {
    test("promotes a diagnostic to a concise warn message", () => {
      const classifier = new OpencodeLogLineClassifier();
      expect(classifier.classify(OVERLAY_DIAGNOSTIC)).toEqual({
        content:
          "OpenCode config warning: OPENCODE_CONFIG_CONTENT $.model (invalid): skipped malformed recognized value",
        level: "warn",
      });
      expect(classifier.classify(GLOBAL_DIAGNOSTIC)).toEqual({
        content:
          "OpenCode config warning: /home/agent/.config/opencode/opencode.json $ (invalid): rejected malformed JSON or JSONC document",
        level: "warn",
      });
    });

    test("demotes repeats of the same diagnostic to the raw line at debug", () => {
      const classifier = new OpencodeLogLineClassifier();
      classifier.classify(OVERLAY_DIAGNOSTIC);
      const repeat = OVERLAY_DIAGNOSTIC.replace(
        "http.span=354",
        "http.span=900",
      );
      expect(classifier.classify(repeat)).toEqual({
        content: repeat,
        level: "debug",
      });
    });
  });
});
