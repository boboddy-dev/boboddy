import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PIPELINE_ASSIGNMENT_FILENAME } from "@boboddy/sdk/definitions/pipelines";

export const PIPELINE_BUILDER_DIR = ".boboddy/pipeline-builder";

export const STARTER_PIPELINE_KEY = "triage-and-plan";
export const STARTER_PIPELINE_FILENAME = `${STARTER_PIPELINE_KEY}.ts`;

type ScaffoldResult = {
  created: string[];
  skipped: string[];
};

function resolveSdkDependency(sdkVersion: string): string {
  const artifactPath = process.env["BOBODDY_SDK_ARTIFACT_PATH"];
  if (artifactPath) {
    return `file:${artifactPath}`;
  }

  // Prerelease versions (e.g. canary) must be pinned exactly: npm's `^`
  // operator matches any prerelease sharing the same major.minor.patch tuple,
  // which can resolve to a different prerelease than the one shipped with this
  // CLI version and cause runtime mismatches (e.g. missing Features.notifications).
  if (sdkVersion.includes("canary")) {
    return sdkVersion;
  }

  return `^${sdkVersion}`;
}

/**
 * The name of the package.json script that typechecks a pipeline-builder
 * directory — i.e. the `<script>` in `bun run <script>`.
 *
 * Load-bearing in two places across two packages: the generated `package.json`
 * below, and §9 of the agent's `AUTHORING.md`, which tells the agent to run
 * `<pm> run <script>`. Renaming it without updating §9 would send the agent after
 * a script that does not exist. `apps/cli/test/design-agent-assets.test.ts` ties
 * both to this constant.
 *
 * It used to be load-bearing in a third place — one wildcard-free carve-out per
 * package manager in the designer's bash allowlist. That allowlist is now
 * allow-by-default, so the coupling is gone and the script name no longer has any
 * bearing on whether the agent gets an approval prompt.
 */
export const PIPELINE_BUILDER_TYPECHECK_SCRIPT_NAME = "typecheck";

/**
 * The one command that typechecks a pipeline-builder directory.
 *
 * Exposed as a package.json script (rather than a raw `tsc` invocation with flag
 * overrides) so it is a single, stable string across every package manager: one
 * command to document in `AUTHORING.md` §9 instead of one per project layout.
 */
export const PIPELINE_BUILDER_TYPECHECK_SCRIPT = "tsc -p tsconfig.json";

export function buildPipelineBuilderPackageJson(sdkVersion: string): string {
  return JSON.stringify(
    {
      name: "pipeline-builder",
      private: true,
      type: "module",
      scripts: {
        [PIPELINE_BUILDER_TYPECHECK_SCRIPT_NAME]:
          PIPELINE_BUILDER_TYPECHECK_SCRIPT,
      },
      dependencies: {
        "@boboddy/sdk": resolveSdkDependency(sdkVersion),
        zod: "^4.4.2",
      },
      // tsx lets `boboddy pipelines push` execute `push.ts` under node-based
      // package managers (npm/pnpm/yarn). bun and deno don't need it.
      // typescript backs the `typecheck` script above; deno users typecheck
      // with `deno check` instead and can ignore it.
      devDependencies: {
        tsx: "^4.20.0",
        typescript: "^5.9.0",
      },
    },
    null,
    2,
  );
}

/**
 * Self-contained tsconfig for the user's pipeline-builder directory.
 *
 * Three settings exist purely so `tsc -p tsconfig.json` is CLEAN out of the box
 * — a noisy baseline trains both humans and the designer agent to ignore
 * typecheck output:
 *
 * - `skipLibCheck` — the SDK's transitive `.d.ts` files are not the user's
 *   problem, and checking them surfaces errors they cannot fix.
 * - `lib: [… "DOM"]` — the SDK's types transitively reference DOM globals
 *   (`fetch`/`Response`/`Headers`); without DOM they are unresolved.
 * - `noEmit` — this project is only ever typechecked, never built.
 *
 * `push.ts` is excluded because `boboddy pipelines push` regenerates it on
 * every run and it uses `import.meta.dirname`, which does not typecheck under
 * these settings. It is a Boboddy-owned artifact, not user code.
 */
export const PIPELINE_BUILDER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      module: "ESNext",
      moduleResolution: "Bundler",
      moduleDetection: "force",
      verbatimModuleSyntax: true,
      resolveJsonModule: true,
      strict: true,
      isolatedModules: true,
      skipLibCheck: true,
      noEmit: true,
      baseUrl: ".",
    },
    include: ["**/*.ts"],
    exclude: ["node_modules", "push.ts"],
  },
  null,
  2,
);

/**
 * Ignore rules for the user's pipeline-builder directory.
 *
 * Deliberately narrow. Pipeline and step definitions are SOURCE — they are the
 * local source of truth the designer agent edits and re-reads, they are what a
 * teammate needs on a fresh clone, and they are what a reviewer should see in a
 * diff. Only genuinely generated or vendored artifacts are ignored:
 *
 * - `node_modules/` — installed dependencies, never committed. Left unanchored
 *   so nested copies from package-manager hoisting are covered too.
 * - Lockfiles — see the note in the file body. Anchored to this directory
 *   because only a lockfile at this level drives runtime detection.
 * - `push.ts` — regenerated from an embedded template on EVERY
 *   `boboddy pipelines push`, so it would otherwise churn in every diff. It is
 *   also excluded from `PIPELINE_BUILDER_TSCONFIG` for the same reason: it is a
 *   Boboddy-owned artifact, not user code.
 *
 * Not listed, and therefore committed: the `.ts` definitions, `package.json`,
 * `tsconfig.json`, and this file itself.
 */
export const PIPELINE_BUILDER_GITIGNORE = `# Boboddy scaffolds and manages this directory, but your pipeline and step
# definitions are source code: commit and review them like any other file.
# Only generated or vendored artifacts are ignored below.

# Installed dependencies.
node_modules/

# Lockfiles. Unusually for a JS project these are NOT committed. This directory
# is a tool-managed harness rather than a deployed artifact — nothing ships from
# here, and \`boboddy pipelines push\` uploads definitions, not builds. More
# importantly, push picks its runtime from whichever lockfile it finds here, so
# a committed lockfile would force every teammate onto one package manager. Each
# developer installs with the tool they have.
/bun.lock
/bun.lockb
/package-lock.json
/pnpm-lock.yaml
/yarn.lock
/deno.lock

# Regenerated from a template on every \`boboddy pipelines push\`.
/push.ts

# Written by the post-push run-offer gate (#146) when its dry run of the
# pushed pipeline's first step fails; read once (and deleted) by the next
# \`boboddy pipelines design\` session's orientation, so it is never meant to be
# committed or reviewed.
/.run-offer-gate-failure.json
`;

// The starter template doubles as the tutorial: a complete two-step pipeline
// showing every core concept (steps, schemas, signals, bindings, advancement)
// in the file users will edit anyway. Both steps run in "no_workspace" mode so
// the pipeline executes end to end without Docker or a devcontainer.
export const STARTER_PIPELINE_FILE = `import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";
import { pipeline } from "@boboddy/sdk/definitions/pipelines";

// Your first Boboddy pipeline: two AI steps connected by a signal.
//
//   work item ──▶ Triage ──(confidence >= 7)──▶ Write Fix Plan ──▶ complete
//                    │
//                    └──(confidence < 7)──▶ blocked for human review
//
// Both steps run in "no_workspace" mode, so this pipeline executes without a
// devcontainer, Docker, or a cloned repository.
//
// Try it end to end:
//   1. boboddy pipelines push   — upload these definitions
//   2. create a work item in the dashboard (any bug-shaped title works)
//   3. boboddy work             — start a worker, then watch the dashboard

// ─── Step 1: Triage ─────────────────────────────────────────────────────────
// A step is a typed unit of AI work: a prompt, an input schema, and a result
// schema the agent's answer must satisfy.
export const triageStep = defineStep({
  key: "triage",
  name: "Triage",
  description: "Diagnose a work item and rate confidence in the diagnosis.",

  // "no_workspace" steps run without cloning your repository — ideal for
  // analysis and planning. Switch to "workspace" (the default) when the agent
  // needs your code; that requires a .devcontainer in your repo.
  executionMode: "no_workspace",

  // The step's full input JSON is shown to the agent automatically.
  // Interpolating a field (like \${input.title} below) is optional and only
  // inlines that value into your instructions.
  agentPrompt: ({ input }) => \`
You are a senior engineer triaging incoming work.
Diagnose the most likely root cause of: \${input.title}
Summarize the problem, rate its severity, and rate your confidence (0-10) in
the diagnosis.
\`,

  // Fields the pipeline must bind when it uses this step (see the pipeline
  // at the bottom of this file).
  additionalInput: z.object({
    title: z.string(),
  }),

  // The agent's reply must match this schema.
  result: z.object({
    summary: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(10),
  }),

  // Signals lift scalar values out of the result so advancement rules and
  // later steps can use them. They also appear as metrics in the dashboard.
  signals: [
    {
      sourcePath: "confidence",
      key: "confidence",
      type: "number",
      required: true,
    },
    { sourcePath: "summary", key: "summary", type: "string" },
    { sourcePath: "severity", key: "severity", type: "string" },
  ],
  status: "active",
});

// ─── Step 2: Write Fix Plan ─────────────────────────────────────────────────
export const writeFixPlanStep = defineStep({
  key: "write-fix-plan",
  name: "Write Fix Plan",
  description: "Turn a triage summary into a concrete, actionable fix plan.",
  executionMode: "no_workspace",
  agentPrompt:
    "Using the triage summary in your input, write a short, concrete " +
    "step-by-step plan to fix the issue.",
  additionalInput: z.object({
    triageSummary: z.string(),
  }),
  result: z.object({
    plan: z.string(),
  }),
  status: "active",
});

// ─── The pipeline ───────────────────────────────────────────────────────────
// A pipeline wires steps together. Each .step() mapper binds that step's
// input; each .advance() decides what happens after the step finishes.
export default pipeline({
  key: "triage-and-plan",
  name: "Triage & Plan",
  description: "Starter pipeline: triage a work item, then plan the fix.",
  status: "active",
})
  // \`input\` always exposes workItemTitle and workItemDescription.
  .step(triageStep, ({ input }) => ({
    title: input.workItemTitle,
  }))
  // Advancement is the heart of Boboddy: rules read signals and decide whether
  // the pipeline continues, blocks for a human, completes, or routes to
  // another pipeline. Here a confident triage continues to the next step;
  // anything else blocks so a human can review it in the dashboard.
  .advance(({ signal }) => ({
    default: "block",
    rules: [signal("confidence").gte(7).then("continue")],
  }))
  // Later steps can bind signals (or the whole output) of earlier steps.
  .step(writeFixPlanStep, ({ signal }) => ({
    triageSummary: signal(triageStep, "summary"),
  }))
  .advance(() => ({ default: "complete" }))
  .build();
`;

// Scaffolded alongside the pipeline so new projects start with automatic
// assignment wired up: every new work item runs the starter pipeline.
export const STARTER_DEFAULT_PIPELINE_ASSIGNMENT_FILE = `import { defaultPipelineAssignment } from "@boboddy/sdk/definitions/pipelines";
import triageAndPlan from "./${STARTER_PIPELINE_KEY}";

// This reserved file controls which pipeline starts automatically when a new
// work item arrives (created in the dashboard or ingested from GitHub/Jira).
// Rules run top to bottom; the first match wins, otherwise \`default\` applies.
export default defaultPipelineAssignment(({ workItem, assign, skip }) => ({
  default: assign(triageAndPlan),
  rules: [
    // Don't start a pipeline for items that arrive already resolved.
    workItem.field("status").eq("resolved").then(skip()),
    // As you add pipelines, route work items to them here, e.g.:
    //   workItem.field("issueType").eq("bug").then(assign(bugTriage)),
  ],
}));
`;

export function scaffoldPipelineBuilderDirectory(
  dir: string,
  sdkVersion: string,
): ScaffoldResult {
  const result: ScaffoldResult = { created: [], skipped: [] };

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  function writeFile(relPath: string, content: string): void {
    const filePath = join(dir, relPath);
    if (existsSync(filePath)) {
      result.skipped.push(relPath);
    } else {
      writeFileSync(filePath, content, "utf-8");
      result.created.push(relPath);
    }
  }

  writeFile("package.json", buildPipelineBuilderPackageJson(sdkVersion));
  writeFile("tsconfig.json", PIPELINE_BUILDER_TSCONFIG);
  writeFile(".gitignore", PIPELINE_BUILDER_GITIGNORE);
  writeFile(STARTER_PIPELINE_FILENAME, STARTER_PIPELINE_FILE);
  // Scaffold the reserved default pipeline assignment file
  writeFile(
    DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
    STARTER_DEFAULT_PIPELINE_ASSIGNMENT_FILE,
  );

  return result;
}
