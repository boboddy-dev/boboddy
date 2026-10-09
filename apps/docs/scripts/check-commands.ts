/**
 * Check every `boboddy …` command shown in the docs against the real CLI
 * parser (docs/plans/docs-onboarding-clarity.md, Phase 7c).
 *
 * Usage: bun scripts/check-commands.ts
 *
 * Scans fenced `bash`/`sh`/`shell`/`zsh`/`console` blocks under
 * `src/content/docs/`. Each line is split on `&&`, `||`, `;`, and `|`; every
 * segment starting with `boboddy` (after an optional `$ ` prompt) is checked.
 * Trailing `# comments` and `<placeholder>` tokens are dropped, and `\` line
 * continuations are joined.
 *
 * Each command is parsed by `createCli` from `apps/cli/src/cli.ts` in strict
 * mode. `--help` is not used: yargs skips strict validation when help is
 * requested, so an unknown flag would pass. Instead `onCommand` — called from
 * the CLI's first middleware, after validation and before any handler — throws
 * a sentinel, so a command that parses never runs. Exits non-zero on any
 * unknown command, unknown flag, or missing argument.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli } from "../../cli/src/cli";

const SHELL_LANGUAGES = new Set(["bash", "sh", "shell", "zsh", "console"]);
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;

export type DocCommand = { file: string; line: number; argv: string[] };

type PendingLine = { text: string; line: number };

export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Split a shell line on `&&`, `||`, `;`, `|`, and an unquoted `#` comment. */
export function splitSegments(line: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (
      char === "#" &&
      (index === 0 || /\s/.test(line[index - 1] ?? ""))
    ) {
      break;
    } else if (char === ";" || char === "|" || char === "&") {
      if (line[index + 1] === char) index += 1;
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

export function extractCommands(source: string, file: string): DocCommand[] {
  const commands: DocCommand[] = [];
  const lines = source.split("\n");
  let fence: { marker: string; shell: boolean } | null = null;
  let pending: PendingLine | null = null;

  for (const [index, raw] of lines.entries()) {
    const match = FENCE.exec(raw);
    if (!fence) {
      if (match?.[1]) {
        fence = {
          marker: match[1],
          shell: SHELL_LANGUAGES.has(match[2] ?? ""),
        };
      }
      continue;
    }
    if (match?.[1]?.startsWith(fence.marker) && !match[2]) {
      fence = null;
      pending = null;
      continue;
    }
    if (!fence.shell) continue;

    const text: string = (pending ? `${pending.text} ` : "") + raw.trim();
    const line: number = pending?.line ?? index + 1;
    if (text.endsWith("\\")) {
      pending = { text: text.slice(0, -1).trimEnd(), line };
      continue;
    }
    pending = null;

    for (const segment of splitSegments(text.replace(/^\$\s+/, ""))) {
      const tokens = tokenize(segment).filter(
        (token) => !/^<[^>]*>$/.test(token),
      );
      if (tokens[0] !== "boboddy") continue;
      commands.push({ file, line, argv: tokens.slice(1) });
    }
  }
  return commands;
}

class Parsed extends Error {}

/** `null` when the CLI accepts `argv`, otherwise the parser's error message. */
export async function parseError(
  argv: readonly string[],
): Promise<string | null> {
  try {
    await createCli(argv, () => {
      throw new Parsed();
    }).parseAsync(argv, {}, () => undefined);
    return null;
  } catch (error) {
    if (error instanceof Parsed) return null;
    return error instanceof Error ? error.message : String(error);
  }
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function main(): Promise<void> {
  const appRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const docsRoot = path.join(appRoot, "src/content/docs");
  const commands = markdownFiles(docsRoot).flatMap((file) =>
    extractCommands(readFileSync(file, "utf8"), path.relative(appRoot, file)),
  );

  let failures = 0;
  for (const command of commands) {
    const error = await parseError(command.argv);
    if (error === null) continue;
    failures += 1;
    console.error(
      `${command.file}:${String(command.line)}: boboddy ${command.argv.join(" ")}\n  ${error}`,
    );
  }

  console.log(
    `Checked ${String(commands.length)} boboddy commands in docs: ${String(failures)} failed.`,
  );
  if (failures > 0) process.exit(1);
}

if (import.meta.main) await main();
