/**
 * Value-based secret masking for the step-execution log feed.
 *
 * GitHub-Actions-style: collect the set of KNOWN secret values (the values we
 * inject into the devcontainer — `.boboddy/.env` and the resolved provider
 * token) and replace every occurrence of any of them in outgoing log content
 * with a fixed mask. This is literal substring masking against known values,
 * not input-aware parsing.
 *
 * Applied at the single choke point every shipped line passes through
 * ({@link StepExecutionLogShipper.enqueue}), so it covers all three streams
 * (`worker`, `ai-server`, `conversation`) regardless of HOW a secret leaked
 * into output (env dump, error message, verbose tool output).
 *
 * Known limitation: masking is literal. A secret that has been transformed
 * before it reaches the log (base64/URL-encoded, or split across lines) will
 * NOT be caught. Catching those is out of scope here (would require entropy /
 * pattern detection).
 */

/** Fixed replacement for a matched secret value. Length is not leaked. */
const MASK = "***";

/**
 * Values shorter than this (after trimming) are ignored. Masking a short,
 * low-entropy value like `"1"`, `"true"`, or a common port would corrupt
 * unrelated log output far more than it protects anything.
 */
const MIN_MASKABLE_LENGTH = 4;

/** Escape a literal string for safe use inside a `RegExp`. */
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Mutable registry of secret values that redacts them from log content.
 *
 * The value set grows over the lifetime of a step: it is seeded with the
 * `.boboddy/.env` values at construction and gains the provider token(s) once
 * the runtime resolves them (which happens after the log stream is created).
 * `register` is therefore idempotent and safe to call repeatedly; the matcher
 * is rebuilt lazily on the next `mask` after the set changes.
 */
export class SecretMasker {
  private readonly values = new Set<string>();
  private pattern: RegExp | null = null;

  constructor(initialValues: Iterable<string> = []) {
    this.register(initialValues);
  }

  /**
   * Add secret values to mask. Blank/whitespace-only values and values shorter
   * than {@link MIN_MASKABLE_LENGTH} (after trimming) are ignored. The raw
   * (untrimmed) value is what is masked, since that is what appears verbatim in
   * output.
   */
  register(values: Iterable<string>): void {
    let changed = false;
    for (const value of values) {
      if (value.trim().length < MIN_MASKABLE_LENGTH) {
        continue;
      }
      if (!this.values.has(value)) {
        this.values.add(value);
        changed = true;
      }
    }
    if (changed) {
      // Invalidate the compiled matcher; rebuilt lazily on next mask().
      this.pattern = null;
    }
  }

  /** Replace every occurrence of every registered secret value with the mask. */
  mask(content: string): string {
    if (this.values.size === 0) {
      return content;
    }
    this.pattern ??= this.compile();
    return content.replace(this.pattern, MASK);
  }

  /**
   * Build a single alternation matcher. Values are sorted longest-first so that
   * when one secret is a substring of another, the longer value is masked as a
   * whole rather than leaving its unique suffix exposed.
   */
  private compile(): RegExp {
    const alternation = [...this.values]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|");
    return new RegExp(alternation, "g");
  }
}
