/**
 * Sanitize an arbitrary step key into a fragment that is safe to embed in a git
 * branch/ref name (see `git check-ref-format`). Rejected characters are
 * replaced with `-`; disallowed leading/trailing forms are stripped.
 *
 * Rules enforced:
 *  - no whitespace, no `~^:?*[` , no `\` , no ASCII control chars
 *  - no `..` sequences, no leading `-` , no leading/trailing `.`
 *  - no trailing `.lock`
 *  - collapse runs of `-` and never return an empty string
 */
export function sanitizeGitRefFragment(raw: string): string {
  let value = raw.trim();

  // Replace any character that is unsafe in a ref name with a dash.
  // eslint-disable-next-line no-control-regex -- intentionally stripping control chars
  value = value.replace(/[\u0000-\u001f\u007f ~^:?*[\\]/g, "-");

  // Collapse `..` (git forbids it) and any run of dots to a single dash.
  value = value.replace(/\.{2,}/g, "-");

  // Collapse runs of slashes/dashes.
  value = value.replace(/\/{2,}/g, "/");
  value = value.replace(/-{2,}/g, "-");

  // No leading dash (would look like a git flag) or dot.
  value = value.replace(/^[-.]+/, "");
  // No trailing dot, slash, or dash.
  value = value.replace(/[-./]+$/, "");

  // No trailing `.lock`.
  value = value.replace(/\.lock$/i, "");
  value = value.replace(/[-./]+$/, "");

  return value.length > 0 ? value : "step";
}
