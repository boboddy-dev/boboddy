---
title: Quickstart
description: Run your first pipeline end to end in about five minutes — no Docker required
---

This guide gets you from zero to a running pipeline in three stages, each one
building on the last:

1. **[See it run](#stage-1--see-it-run-no-docker)** — design a pipeline for your
   project and watch it execute. No Docker, no devcontainer. ~10 minutes.
2. **[Point it at your repo](#stage-2--point-it-at-your-repo)** — let steps work
   inside your codebase using a dev container.
3. **[Automate intake](#stage-3--automate-intake)** — pull work items from
   GitHub or Jira and route them to pipelines automatically.

If you haven't installed the CLI yet, do that first — see
[Installation](/boboddy/getting-started/installation/).

---

## Stage 1 — See it run (no Docker)

You'll design a pipeline for your own project by talking to an AI agent, then
watch it execute. `boboddy pipelines design` itself runs entirely on your host —
no container. And because the designer only proposes designs your environment can
actually support, a repo with no dev container gets steps in **`no_workspace`
mode**: the agent runs on the host in a scratch directory instead of cloning your
repo into a container. So this whole stage stays Docker-free.

**What you need for this stage:** the `boboddy` CLI and your own AI provider
credentials for OpenCode (an `opencode auth login`, or an env var like
`ANTHROPIC_API_KEY`). You do **not** need Docker, a devcontainer, or OpenCode
installed — Boboddy downloads and pins its own OpenCode runtime.

### 1. Log in

```bash
boboddy auth login
```

### 2. Create a project

Open the [dashboard](https://app.boboddy.dev), click **Create Project**, and
give it a name. After it's created you'll land on the project's work-items page —
copy the project ID from the URL (`/projects/<projectId>/work-items`).

> We create the project from the dashboard here (rather than `boboddy init`)
> because `init` requires a dev container. You'll set one up in
> [Stage 2](#stage-2--point-it-at-your-repo).

### 3. Design a pipeline

From the root of your repository:

```bash
boboddy pipelines design <projectId>
```

This one command handles everything a pipeline needs. It signs you in if you
aren't, scaffolds `.boboddy/pipeline-builder/` if it's missing, installs that
directory's dependencies, and downloads the OpenCode runtime — **a one-time
~100 MB download** with a progress bar. Then it drops you into an interactive
session with a `pipeline-designer` agent.

> The one thing it cannot do for you is obtain AI provider credentials. If you
> have none, it stops and prints the exact `auth login` command for the runtime
> it just provisioned. Run that, then re-run `design`.

First it asks you to pick a work item — one of the project's recent ingested
items, or paste a ticket URL or describe one in a sentence and it creates the
item for you. **Every session designs around a real work item.** That item is
what the whole interview is about, so pick something typical rather than your
weirdest edge case.

The agent reads your repository first, so it won't ask about your stack. It opens
on the goal — *what should come out the other end when a ticket like this one
arrives?* — and everything after that is asked through the item you picked, one
question at a time:

- **The deliverable.** If that ticket landed overnight and an agent picked it up,
  what would you want waiting for you in the morning, and what would you have to
  see to trust it?
- **What the execution environment can reach.** To make progress on that ticket
  yourself, what's the first thing you'd do — open the app, run a test, query the
  DB? Then: could an automated agent do the same thing, and how would it
  authenticate? "Nothing but the repository" is a completely normal answer and
  still supports a good pipeline.
- **What must never be touched.** Working that ticket, what would you be angry to
  find an agent had done? Production writes, customer data, anything that sends
  email or charges money.

It then proposes two or three ranked pipeline designs — filtered to what you
actually said is reachable — and builds the one you pick, plus a
`default-pipeline-assignment.ts` so incoming work items route to it. Finally it
typechecks the definitions and runs `boboddy pipelines push`.

> Shell commands are gated by permission prompts. The prompt on
> `boboddy pipelines push` is your confirmation — nothing reaches the server
> until you approve it.

`design` needs a real terminal; it won't work through a pipe or in CI. It's also
**re-runnable**: run it again with a different work item and it reads your
existing definitions and iterates on them rather than starting over. In those
sessions it tells you up front how big a change it thinks you need — tweak an
existing pipeline, route these items to one, or add a new pipeline — and waits
for you to agree before it edits anything. Same command for day one and day
fifty.

> Prefer to write the definitions yourself? `boboddy pipelines init` scaffolds a
> commented `triage-and-plan.ts` starter pipeline plus
> `default-pipeline-assignment.ts` for you to hand-edit — it's the manual path
> and needs no AI provider:
>
> ```bash
> boboddy pipelines init
> cd .boboddy/pipeline-builder && npm install   # or bun/pnpm/yarn install
> npm run typecheck
> cd ../.. && boboddy pipelines push <projectId>
> ```
>
> See [Defining Steps](/boboddy/guides/steps/) and
> [Building Pipelines](/boboddy/guides/pipelines/).

### 4. Create a work item

Back in the dashboard, open your project and create a work item that looks like
the real ones you described, e.g. *"Checkout button does nothing on mobile
Safari"*. The `default-pipeline-assignment.ts` the agent wired up starts your
pipeline automatically.

> The item you designed around in step 3 won't start a run by itself. To use it
> here instead of a fresh one, open it and start a run from its executions
> drawer.

### 5. Run a worker and watch it advance

```bash
boboddy work <projectId>
```

The worker claims the pending step execution, runs the step's agent, and reports
its signals back. Watch the pipeline view in the dashboard: each `.advance()`
rule reads those signals and decides whether the pipeline continues, blocks for a
human, or completes. That advance-on-signal moment is the core of Boboddy.

That's a full pipeline run. When you're ready to have agents work inside your
actual codebase, continue to Stage 2.

---

## Stage 2 — Point it at your repo

`no_workspace` steps are great for analysis and planning, but most real work
needs your code. **`workspace` mode** (the default for a step) clones your
repository into a dev container and runs the agent there, so it can read, edit,
run, and test your project.

### 1. Initialize the project with the CLI

Start here — there is nothing to prepare first:

```bash
cd my-repo
boboddy init
```

This authenticates you (if needed), creates or selects a project, and writes
`.boboddy/boboddy.jsonc` with your `projectId` — so you can drop the explicit
`<projectId>` argument from later commands. It also checks for a
`.devcontainer/devcontainer.json` and tells you if there isn't one. That is a
notice, not a blocker: the next step is what creates it.

`init` does not analyze your repo — the design agent reads the repository itself
at the start of a session.

`init` never creates a pipeline itself — authoring lives in one place. Re-running
it on a configured project is safe: it re-checks the dev container and offers the
handoff again.

### 2. Let the design session author the dev container

Workspace-mode execution needs a `.devcontainer/devcontainer.json`. If your repo
doesn't have one, the design session writes it for you — it has already read your
runtime pins, lockfile, `docker-compose.yml` and CI config, so it has everything
it needs. It won't build the image; your first pipeline run does that.

Prefer to write it by hand? Follow
[Setting up a Dev Container](/boboddy/guides/devcontainer/), which includes an AI
prompt that generates a minimal one for your stack.

### 3. Switch a step to workspace mode

With a dev container in place, re-running `boboddy pipelines design` will propose
designs that can build and test your code — ask the agent to add a
workspace-mode step.

To do it by hand, set `executionMode` to `"workspace"` in your step definition
(or omit it — it's the default) so the agent gets your cloned repo:

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

The `default-pipeline-assignment.ts` file in `.boboddy/pipeline-builder/` decides
which pipeline runs for each incoming work item. Rules are evaluated top to
bottom; the first match wins:

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
│   ├── boboddy.jsonc                    # project config (projectId, optional branchPrefix)
│   └── pipeline-builder/                # steps and pipeline definitions
│       ├── package.json                 # SDK + zod deps, `typecheck` script
│       ├── tsconfig.json
│       ├── .gitignore
│       ├── <your-pipeline>.ts           # one file per pipeline
│       ├── default-pipeline-assignment.ts
│       ├── node_modules/                # ignored
│       └── push.ts                      # ignored; regenerated by every push
└── .devcontainer/
    └── devcontainer.json                # execution environment (workspace-mode steps)
```

**Everything in `.boboddy/pipeline-builder/` is committed except
`node_modules/`, lockfiles, and `push.ts`.** Your pipeline and step definitions
are source code — review them in pull requests like any other file.

Lockfiles are the surprising exclusion. `boboddy pipelines push` picks its
runtime from whichever lockfile it finds in that directory, so committing one
would force every teammate onto the same package manager. Each developer installs
with the tool they already have.

Run `npm run typecheck` (or the bun/pnpm/yarn equivalent) inside
`.boboddy/pipeline-builder/` to validate your definitions before pushing.

## Where to go next

- [Defining Steps](/boboddy/guides/steps/) — inputs, results, signals, and
  execution modes.
- [Building Pipelines](/boboddy/guides/pipelines/) — bindings, advancement
  policies, and computed signals.
- [Running Workers](/boboddy/guides/workers/) — scaling and worker options.
