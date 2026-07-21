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

export function buildPipelineBuilderPackageJson(sdkVersion: string): string {
  return JSON.stringify(
    {
      name: "pipeline-builder",
      private: true,
      type: "module",
      dependencies: {
        "@boboddy/sdk": resolveSdkDependency(sdkVersion),
        zod: "^4.4.2",
      },
      // tsx lets `boboddy pipelines push` execute `push.ts` under node-based
      // package managers (npm/pnpm/yarn). bun and deno don't need it.
      devDependencies: {
        tsx: "^4.20.0",
      },
    },
    null,
    2,
  );
}

export const PIPELINE_BUILDER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "ESNext",
      moduleResolution: "Bundler",
      moduleDetection: "force",
      verbatimModuleSyntax: true,
      resolveJsonModule: true,
      strict: true,
      isolatedModules: true,
      baseUrl: ".",
    },
    include: ["**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
);

export const PIPELINE_BUILDER_GITIGNORE = `*
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
