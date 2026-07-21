---
title: Quickstart
description: Run your first pipeline end to end in about five minutes — no Docker required
---

This guide gets you from zero to a running pipeline in three stages, each one
building on the last:

1. **[See it run](#stage-1--see-it-run-no-docker)** — push the starter pipeline
   and watch it execute. No Docker, no devcontainer. ~5 minutes.
2. **[Point it at your repo](#stage-2--point-it-at-your-repo)** — let steps work
   inside your codebase using a dev container.
3. **[Automate intake](#stage-3--automate-intake)** — pull work items from
   GitHub or Jira and route them to pipelines automatically.

If you haven't installed the CLI yet, do that first — see
[Installation](/boboddy/getting-started/installation/).

---

## Stage 1 — See it run (no Docker)

The starter pipeline uses steps that run in **`no_workspace` mode**: the AI agent
runs on the host in a scratch directory instead of cloning your repo into a
container. That means you can watch a pipeline execute end to end without Docker
or a `.devcontainer` — the fastest way to understand how Boboddy works.

**What you need for this stage:** the `boboddy` CLI (logged in) and an AI
provider configured for OpenCode. You do **not** need Docker or a devcontainer.

### 1. Log in

```bash
boboddy auth login
```

### 2. Create a project

Open the [dashboard](https://app.boboddy.dev), click **Create Project**, and
give it a name. After it's created you'll land on the project's work-items page —
copy the project ID from the URL (`/projects/<projectId>/work-items`). You'll
pass it to the CLI below.

> We create the project from the dashboard here (rather than `boboddy init`)
> because `init` requires a dev container. You'll set one up in
> [Stage 2](#stage-2--point-it-at-your-repo).

### 3. Scaffold the starter pipeline

From inside any git repository, scaffold the pipeline builder:

```bash
boboddy pipelines init
cd .boboddy/pipeline-builder
npm install   # or bun install
```

This writes a **`triage-and-plan.ts`** starter pipeline. It's a complete,
commented example — treat it as the tutorial. It defines two AI steps wired
together by a signal:

```
work item ──▶ Triage ──(confidence >= 7)──▶ Write Fix Plan ──▶ complete
                 │
                 └──(confidence < 7)──▶ blocked for human review
```

Open the file and read through it before moving on — it's the quickest way to
learn steps, signals, and advancement. See [Defining Steps](/boboddy/guides/steps/)
and [Building Pipelines](/boboddy/guides/pipelines/) for the full reference.

### 4. Push it

Upload the step and pipeline definitions to the server. Pass the project ID you
copied in step 2:

```bash
boboddy pipelines push <projectId>
```

### 5. Create a work item

Back in the dashboard, open your project and create a work item. Any bug-shaped
title works, e.g. *"Checkout button does nothing on mobile Safari"*. The
starter project's default assignment automatically starts the `triage-and-plan`
pipeline for new work items.

### 6. Run a worker and watch it advance

```bash
boboddy work <projectId>
```

The worker claims the pending step execution, runs the Triage step's agent on
the host, and reports its signals back. Watch the pipeline view in the
dashboard: when `confidence` is 7 or higher, the pipeline advances to **Write
Fix Plan**; otherwise it **blocks** for review. That advance-on-signal moment is
the core of Boboddy.

That's a full pipeline run — no containers involved. When you're ready to have
agents work inside your actual codebase, continue to Stage 2.

---

## Stage 2 — Point it at your repo

`no_workspace` steps are great for analysis and planning, but most real work
needs your code. **`workspace` mode** (the default for a step) clones your
repository into a dev container and runs the agent there, so it can read, edit,
run, and test your project.

### 1. Add a dev container

Workspace-mode execution needs a `.devcontainer/devcontainer.json` in your repo.
Follow [Setting up a Dev Container](/boboddy/guides/devcontainer/) — it includes
an AI prompt that generates a minimal one for your stack.

### 2. Initialize the project with the CLI

Now that a dev container exists, `boboddy init` works and wires up local config
for you:

```bash
cd my-repo
boboddy init
```

This authenticates you (if needed), creates or selects a project, verifies the
dev container, and writes `.boboddy/boboddy.jsonc` with your `projectId` — so
you can drop the explicit `<projectId>` argument from later commands.

### 3. Switch a step to workspace mode

In your step definition, set `executionMode` to `"workspace"` (or omit it — it's
the default) so the agent gets your cloned repo:

```typescript
export const fixStep = defineStep({
  key: "apply-fix",
  name: "Apply Fix",
  executionMode: "workspace", // clone the repo into a dev container
  agentPrompt: "Implement the fix described in your input and run the tests.",
  // ...
});
```

Push again and run a worker:

```bash
boboddy pipelines push
boboddy work
```

The worker now spins up your dev container per step execution and runs the agent
inside it. See [Running Workers](/boboddy/guides/workers/) for all worker
options.

---

## Stage 3 — Automate intake

So far you've created work items by hand. In production, you'll want them to flow
in automatically and route to the right pipeline.

### Ingest from GitHub or Jira

Connect an integration from your project's settings in the dashboard. Once
connected, Boboddy ingests issues as work items — each becomes a pipeline run.

### Route work items with a default assignment

The `default-pipeline-assignment.ts` file (scaffolded alongside your starter
pipeline) decides which pipeline runs for each incoming work item. Rules are
evaluated top to bottom; the first match wins:

```typescript
export default defaultPipelineAssignment(({ workItem, assign, skip }) => ({
  default: assign(triageAndPlan),
  rules: [
    workItem.field("status").eq("resolved").then(skip()),
    workItem.field("issueType").eq("bug").then(assign(bugTriage)),
  ],
}));
```

See [Default pipeline assignment](/boboddy/guides/pipelines/#default-pipeline-assignment)
for the full API.

---

## Project structure

After completing setup, your repo will have:

```
my-repo/
├── .boboddy/
│   ├── boboddy.jsonc                    # project config (written by `boboddy init`)
│   └── pipeline-builder/                # steps and pipeline definitions
│       ├── package.json
│       ├── tsconfig.json
│       ├── .gitignore
│       ├── triage-and-plan.ts           # the starter pipeline
│       └── default-pipeline-assignment.ts
└── .devcontainer/
    └── devcontainer.json                # execution environment (workspace-mode steps)
```

## Where to go next

- [Defining Steps](/boboddy/guides/steps/) — inputs, results, signals, and
  execution modes.
- [Building Pipelines](/boboddy/guides/pipelines/) — bindings, advancement
  policies, and computed signals.
- [Running Workers](/boboddy/guides/workers/) — scaling and worker options.
