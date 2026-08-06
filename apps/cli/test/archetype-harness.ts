// Helpers for `design-agent-archetypes.test.ts`: pulling code out of the
// authoring reference and standing up a throwaway project that compiles it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every fence tag `AUTHORING.md` is allowed to use.
 *
 * This is the compilable-vs-fragment mechanism, and it is deliberately
 * opt-OUT: a plain ```` ```ts ```` fence is compiled as a standalone file, and
 * only a fence explicitly tagged ```` ```ts fragment ```` is skipped. Adding a
 * new snippet therefore puts it under the compiler by default; you have to say
 * out loud that a block is a partial illustration to get out of that. The
 * reference's own preamble documents the two tags for the agent reading it, so
 * the marker is meaningful to its primary audience rather than being test-only
 * metadata. `design-agent-archetypes.test.ts` rejects any tag not listed here,
 * so a typo cannot quietly opt a block out.
 */
export const KNOWN_FENCE_TAGS: readonly string[] = ["ts", "ts fragment", "sh"];

export type FencedBlock = {
  /** The fence's info string, trimmed. `""` for an untagged fence. */
  readonly tag: string;
  /** The block's contents, dedented by the fence's own indentation. */
  readonly code: string;
};

const FENCE = /^(\s*)```(.*)$/;

/** Every fenced block in a markdown document, in order. */
export function extractFencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let indent: string | null = null;
  let tag = "";
  let lines: string[] = [];

  for (const line of markdown.split("\n")) {
    const match = FENCE.exec(line);
    if (indent === null) {
      if (match) {
        indent = match[1] ?? "";
        tag = (match[2] ?? "").trim();
        lines = [];
      }
      continue;
    }
    if (match && (match[2] ?? "").trim() === "") {
      blocks.push({ tag, code: lines.join("\n") });
      indent = null;
      continue;
    }
    lines.push(line.startsWith(indent) ? line.slice(indent.length) : line);
  }

  return blocks;
}

/** The blocks that are meant to compile as standalone files. */
export function extractCompilableSnippets(markdown: string): string[] {
  return extractFencedBlocks(markdown)
    .filter((block) => block.tag === "ts")
    .map((block) => `${block.code.trim()}\n`);
}

/**
 * The `steps.ts` the reference's section 0 documents, in the shape its own
 * snippets import: `investigate` with the four signals section 1 declares, and
 * `writeFix` with the required `context` input section 2 binds.
 *
 * Snippets import shared steps rather than redefining them, which is both the
 * idiomatic layout for a real pipeline-builder directory and the reason those
 * snippets can be compiled at all.
 */
export const SHARED_STEPS_FIXTURE = `import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";

export const investigate = defineStep({
  key: "investigate",
  name: "Investigate",
  status: "active",
  agentPrompt: "Investigate the reported problem.",
  additionalInput: z.object({
    accountRef: z.string().nullable().optional(),
  }),
  result: z.object({
    findings: z.string(),
    rootCause: z.string(),
    confidence: z.number(),
    identifiedFix: z.boolean(),
  }),
  signals: [
    { sourcePath: "findings" },
    { sourcePath: "rootCause" },
    { sourcePath: "confidence" },
    { sourcePath: "identifiedFix" },
  ],
});

export const writeFix = defineStep({
  key: "write-fix",
  name: "Write Fix",
  status: "active",
  agentPrompt: "Implement the fix described in your input.",
  additionalInput: z.object({ context: z.string() }),
  result: z.object({ summary: z.string() }),
  signals: [{ sourcePath: "summary" }],
});
`;

type TsconfigShape = {
  compilerOptions: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
};

export type WriteHarnessTsconfigInput = {
  /** Directory the harness files were written to. */
  readonly dir: string;
  /** Monorepo root, used to locate the SDK source. */
  readonly repoRoot: string;
  /** `PIPELINE_BUILDER_TSCONFIG` — the config the user's directory really uses. */
  readonly tsconfig: string;
};

/**
 * Write the harness `tsconfig.json`.
 *
 * Derived from the scaffolder's `PIPELINE_BUILDER_TSCONFIG` so the archetypes
 * are verified under the exact compiler options the user will run, and so a
 * change to those options is reflected here automatically. Four deltas:
 *
 * - `paths` — resolve `@boboddy/sdk` to the SDK's real source under
 *   `packages/sdks/js/src`. `apps/cli/tsconfig.json` has no such mapping, and
 *   the point of the harness is to catch drift in source, not in a stale build.
 * - `lib` gains `DOM.Iterable` — the user compiles the SDK's `.d.ts` files with
 *   `skipLibCheck`, so its generated client is never checked there. We compile
 *   that source, and it needs `URLSearchParams.entries()`.
 * - `types: []` — nothing here needs ambient types, and the borrowed
 *   `node_modules` carries `@types` packages the user's directory would not.
 * - `baseUrl` removed — unnecessary with absolute `paths`, and rejected by
 *   `tsgo`, which keeps this config usable with either compiler.
 */
export function writeHarnessTsconfig({
  dir,
  repoRoot,
  tsconfig,
}: WriteHarnessTsconfigInput): void {
  const parsed = JSON.parse(tsconfig) as TsconfigShape;
  const sdkSrc = join(repoRoot, "packages", "sdks", "js", "src");
  const lib = parsed.compilerOptions["lib"];
  const libs = Array.isArray(lib)
    ? lib.filter((entry): entry is string => typeof entry === "string")
    : [];

  delete parsed.compilerOptions["baseUrl"];
  parsed.compilerOptions["lib"] = [...new Set([...libs, "DOM.Iterable"])];
  parsed.compilerOptions["types"] = [];
  parsed.compilerOptions["paths"] = {
    "@boboddy/sdk": [join(sdkSrc, "index.ts")],
    "@boboddy/sdk/*": [join(sdkSrc, "*")],
  };
  parsed.include = ["*.ts"];
  parsed.exclude = ["node_modules"];

  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf-8",
  );
}
