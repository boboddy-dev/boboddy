import { parseOpencodeConfigDiagnostics } from "../../../runtime/runtime-service/infra/opencode-config-diagnostics";
import type { LogLevel } from "./task-log-shipper";

export type ClassifiedAiServerLine = { content: string; level: LogLevel };

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;
const STRUCTURED_PREFIX = /^timestamp=\S+ level=(\w+)/u;

export const stripAnsi = (line: string): string =>
  line.replace(ANSI_PATTERN, "");

/**
 * OpenCode's `INFO` output (watchers, spawned processes, every bus event) is
 * verbose runtime chatter, not product data, so it maps to `debug` and stays
 * out of the durable feed under the default `info` ship level. The structured
 * conversation stream carries the transcript users actually see.
 */
const mapStructuredLevel = (level: string): LogLevel => {
  switch (level.toUpperCase()) {
    case "WARN":
    case "WARNING":
      return "warn";
    case "ERROR":
    case "FATAL":
      return "error";
    default:
      return "debug";
  }
};

/**
 * Keyword fallback for unstructured output: raw crash output and the launch
 * wrapper's `boboddy:` messages, which only ever report launch problems and so
 * are at least `warn`. `null` means no severity marker was found.
 */
const classifyByKeyword = (line: string): LogLevel | null => {
  const lower = line.toLowerCase();
  if (/\b(error|exception|fatal|panic|unhandled)\b/u.test(lower)) {
    return "error";
  }
  if (
    /\b(warn|warning|deprecated)\b/u.test(lower) ||
    lower.startsWith("boboddy:")
  ) {
    return "warn";
  }
  return null;
};

/**
 * Stateful severity classifier for one OpenCode serve-log tail.
 *
 * - Structured `timestamp=… level=…` lines take their level from `level=`.
 * - Unstructured lines use the keyword heuristic; without a marker they inherit
 *   the level of the last structured line, so a multi-line stack trace under an
 *   `ERROR` line stays at `error`. Blank lines are always `debug`.
 * - The first occurrence of each configuration normalization diagnostic is
 *   rewritten as a concise `warn` message. OpenCode repeats the same diagnostic
 *   on every config load, so repeats are demoted to `debug`.
 */
export class OpencodeLogLineClassifier {
  private inheritedLevel: LogLevel = "debug";
  private readonly seenDiagnostics = new Set<string>();

  classify(rawLine: string): ClassifiedAiServerLine {
    const line = stripAnsi(rawLine);
    const structured = STRUCTURED_PREFIX.exec(line);
    if (structured === null) {
      if (line.trim() === "") {
        return { content: line, level: "debug" };
      }
      return {
        content: line,
        level: classifyByKeyword(line) ?? this.inheritedLevel,
      };
    }
    this.inheritedLevel = mapStructuredLevel(structured[1] ?? "");
    return (
      this.promoteConfigDiagnostic(line) ?? {
        content: line,
        level: this.inheritedLevel,
      }
    );
  }

  private promoteConfigDiagnostic(line: string): ClassifiedAiServerLine | null {
    const [diagnostic] = parseOpencodeConfigDiagnostics(line);
    if (diagnostic === undefined) {
      return null;
    }
    const key = [
      diagnostic.source,
      diagnostic.path,
      diagnostic.kind,
      diagnostic.action,
    ].join("\u0000");
    if (this.seenDiagnostics.has(key)) {
      return { content: line, level: "debug" };
    }
    this.seenDiagnostics.add(key);
    return {
      content: `OpenCode config warning: ${diagnostic.source} ${diagnostic.path} (${diagnostic.kind}): ${diagnostic.action}`,
      level: "warn",
    };
  }
}
