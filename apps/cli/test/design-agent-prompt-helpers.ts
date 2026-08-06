/**
 * Shared vocabulary for the tests that read the composed pipeline-designer prompt
 * as a document: phase headings, section slicing, and whitespace-insensitive
 * phrase matching.
 *
 * Extracted so the prompt's *content* (`design-agent-interview.test.ts`) and its
 * *plumbing* (`design-agent-assets.test.ts`) can be asserted in separate files
 * without either restating the other's helpers.
 */

import { expect } from "bun:test";

/**
 * `toContain` for a phrase that may be wrapped across lines.
 *
 * The markdown assets are hard-wrapped at 80 columns, so a sentence-length
 * needle matched verbatim asserts the wrap column as much as the words —
 * re-flowing a paragraph would fail a test that has no opinion about layout.
 * Collapsing runs of whitespace on both sides keeps the assertion about the
 * instruction. Short needles (headings, identifiers) use `toContain` directly.
 */
const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

export function expectPhrase(haystack: string, phrase: string): void {
  expect(collapseWhitespace(haystack)).toContain(collapseWhitespace(phrase));
}

/** The negative direction. A reflow must not make a ban silently pass either. */
export function expectNoPhrase(haystack: string, phrase: string): void {
  expect(collapseWhitespace(haystack)).not.toContain(
    collapseWhitespace(phrase),
  );
}

/**
 * The interview phase headings, named once.
 *
 * Sections are addressed by heading text, and the numbers are part of it because
 * the prompt cross-references phases by number ("you owe the user a verdict in
 * phase 4"). Renumbering therefore has to be a deliberate edit here rather than
 * something a re-ordered prompt gets away with — but it should be *one* edit, so
 * no test spells a heading out inline.
 */
export const PHASE = {
  orient: "## 1. Orient before you ask anything",
  goal: "## 2. Open with the goal",
  reachability: "## 3. Establish reachability",
  changeSize: "## 4. Name the change size",
  proposals: "## 5. Propose 2–3 ranked options",
  devcontainer: "## 6. Author a devcontainer if there is none",
  build: "## 7. Build it",
  assignment: "## 8. Wire the assignment",
  validate: "## 9. Validate",
  close: "## 10. Close",
} as const;

/**
 * The same headings keyed by phase number, so a test can resolve a `phase N`
 * cross-reference in the prompt back to the heading it is supposed to name.
 */
export const PHASE_HEADINGS: Readonly<Record<number, string>> =
  Object.fromEntries(
    Object.values(PHASE).map((headingText) => [
      Number(/^## (\d+)\./u.exec(headingText)?.[1]),
      headingText,
    ]),
  );

/**
 * The prompt text from one heading up to the next, so an assertion about a phase
 * cannot be satisfied by text somewhere else in a 56 KB prompt.
 */
export function sectionBetween(
  prompt: string,
  from: string,
  to: string,
): string {
  const start = prompt.indexOf(from);
  const end = prompt.indexOf(to);
  expect(start, `missing section heading: ${from}`).toBeGreaterThan(0);
  expect(end, `missing section heading: ${to}`).toBeGreaterThan(start);
  return prompt.slice(start, end);
}
