import type { SecretMasker } from "../../../work/task/application/secret-masker";

/**
 * Formats the tail of an OpenCode serve log for appending to a startup failure
 * message. Shared by the host and devcontainer bootstraps.
 *
 * ANSI colors are stripped and known secret values masked: this text lands in
 * the step's `errorJson`, which does not pass through the log shipper's masker.
 */

const LOG_EXCERPT_MAX_LINES = 30;
const LOG_EXCERPT_MAX_CHARS = 4_000;
// eslint-disable-next-line no-control-regex -- matching ANSI escape sequences
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Empty when `raw` is missing or blank. */
export function formatServeLogExcerpt(
  raw: string | null,
  masker: SecretMasker,
): string {
  if (raw === null) {
    return "";
  }
  const lines = masker
    .mask(raw.replace(ANSI_ESCAPE_PATTERN, ""))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }
  let excerpt = lines.slice(-LOG_EXCERPT_MAX_LINES).join("\n");
  if (excerpt.length > LOG_EXCERPT_MAX_CHARS) {
    excerpt = excerpt.slice(-LOG_EXCERPT_MAX_CHARS);
  }
  return `\nOpenCode serve log (last lines):\n${excerpt}`;
}
