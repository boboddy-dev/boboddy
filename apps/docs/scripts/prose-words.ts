/**
 * Count the prose words on a docs page — the Quickstart's ≤ 900-word budget
 * (docs/plans/docs-onboarding-clarity.md, Phase 2).
 *
 * Usage: bun scripts/prose-words.ts <file.md|file.mdx> [--max <n>]
 *
 * Not counted: frontmatter, `import`/`export` lines, fenced code blocks, MDX
 * comments, JSX/MDX component tags, images, link URLs, and HTML comments.
 * Counted: everything a reader reads as text, including table cells — the
 * Quickstart's provider table is content the reader has to take in. Table
 * words are also reported on their own so the split is visible.
 *
 * With `--max`, exits non-zero when the count exceeds the budget.
 */
import { readFileSync } from "node:fs";

const WORD = /[\p{L}\p{N}]/u;

function stripNonProse(source: string): string {
  return source
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
    .replace(/^(?:import|export)\s[^\n]*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^:::[a-z]*/gm, "");
}

function countWords(text: string): number {
  return text
    .split(/\s+/)
    .filter((token) => WORD.test(token))
    .length;
}

function tableText(text: string): string {
  return text
    .split("\n")
    .filter((line) => /^\s*\|/.test(line))
    .join("\n");
}

function parseArgs(argv: readonly string[]): { file: string; max?: number } {
  const [file, ...rest] = argv;
  if (file === undefined) {
    throw new Error("Usage: bun scripts/prose-words.ts <file> [--max <n>]");
  }
  const maxIndex = rest.indexOf("--max");
  if (maxIndex === -1) {
    return { file };
  }
  const max = Number(rest[maxIndex + 1]);
  if (!Number.isInteger(max)) {
    throw new Error("--max needs an integer");
  }
  return { file, max };
}

const { file, max } = parseArgs(process.argv.slice(2));
const prose = stripNonProse(readFileSync(file, "utf8"));
const total = countWords(prose);
const inTables = countWords(tableText(prose));

console.log(`${file}: ${String(total)} prose words (${String(inTables)} in tables)`);

if (max !== undefined && total > max) {
  console.error(`Over budget: ${String(total)} > ${String(max)}`);
  process.exit(1);
}
