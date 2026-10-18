---
title: Core concepts
description: The vocabulary the rest of the docs assume
---

These are the words the rest of the docs use without stopping to explain
them. They're in the order you meet them in the
[Quickstart](/boboddy/getting-started/quickstart/).

## Project

A project is a repository linked to Boboddy, and the unit that owns your
pipelines, work items, and workers. `boboddy init` reads your repository's
`origin` remote and either finds the project that matches it or creates one,
then records it in `.boboddy/boboddy.jsonc` as `owner/slug` — the owner's
username and the project slug, the same pair as its web URL — so later commands
don't need it. See [`boboddy init`](/boboddy/reference/cli/#boboddy-init).

## Work item

A work item is one thing to do: an issue, a ticket, or a sentence you typed.
Work items are synced from GitHub or Jira, or created by hand — the designer
creates one for you when you describe the work instead of picking an existing
item. **Every pipeline run is a run on one work item**, and every design
session is built around one. See [Connect GitHub or Jira](/boboddy/how-to/integrations/).

## Pipeline

A pipeline is a map of named states; each state does a step and names what
runs next. Besides running a step, a state can branch, fan out, loop, or end
the run with `succeed` or `fail`. Pipelines are TypeScript files in
`.boboddy/pipeline-builder/`, written with `definePipeline()`. See
[Building Pipelines](/boboddy/guides/pipelines/).

## Default pipeline

The default pipeline is the one the designer starts every new pipeline from:
`bug-pipeline.ts`. It scores whether a bug report holds enough to act on, and
asks the reporter for what's missing if it doesn't. Otherwise it investigates
and reproduces the bug, writes a failing test, and proposes a fix. The
designer adapts the investigate step to what your environment can reach. Each
step passes its whole output to the next, and nothing blocks: a step that
can't do something says so, and the next one works from that.

## Step

A step is the unit of work: an agent prompt, a typed result, and the signals
it reports. The agent reads the prompt, does the work, and returns a result
that must match the step's schema. Each step runs on the host or inside your
devcontainer — see [Runtime](#runtime) below. See
[Defining Steps](/boboddy/guides/steps/).

## Evidence and artifacts

Evidence is what a step leaves behind so you can check its work. Some of it is
in the step's result, such as the default pipeline's investigation report.
The rest is files: anything the agent writes to `${boboddy.artifactsDir}` is
uploaded as one of the step's artifacts when it finishes. In the dashboard, a
step's _Output_ shows its result and _Artifacts_ lists its files. A
Playwright trace gets a **View trace** button that opens it in Playwright's
trace viewer. See [Prompt context](/boboddy/guides/steps/#prompt-context).

## Signal

A signal is a number, string, or boolean extracted from a step's result, such
as a `quality` score. Declare one only when a rule reads it: a rule can't
look inside the full result, only at the signals the step declares. Later
steps don't need signals, because they receive earlier steps' whole output.
See [Signals](/boboddy/guides/steps/#signals).

## Advancement

Advancement is what happens after a step finishes. Usually that's its state's
`next`. A `choice` state, a loop, or a `blockWhen` rule reads signals to
branch, loop, or block for a human; a blocked run stops in the dashboard
instead of moving on. The default pipeline has one rule, its quality check.
See [Pipeline Advancement](/boboddy/guides/pipeline-advancement/).

## Default pipeline assignment

Default pipeline assignment is the set of rules that picks a pipeline for each
arriving work item. It lives in
`.boboddy/pipeline-builder/default-pipeline-assignment.ts`, and the designer
writes one wired to the pipeline it builds. If no rule matches and the default
is `skip()`, nothing starts. See
[Default Pipeline Assignment](/boboddy/guides/pipeline-assignment/).

## Worker

A worker is `boboddy work`: a process on your machine that claims tasks, runs
the agent, and reports its result and artifacts back. A task is one attempt at one step for one
work item. Nothing runs until a worker is up, and you
can run as many as you like, on a laptop or a CI box. See
[Running Workers](/boboddy/guides/workers/).

## Runtime

A step's runtime decides where its agent runs. `Runtime.devcontainer()` is the
default: the worker clones your repository and runs the agent inside the
container your `.devcontainer/devcontainer.json` describes, which needs
Docker. `Runtime.host()` runs the agent on the worker's machine in an empty
scratch directory, with no clone and no Docker — the designer uses it for
steps that don't need your code, such as classification, scoring, and triage.

**A devcontainer is optional to start, and the designer writes one.** If your
repository has none, the design session authors
`.devcontainer/devcontainer.json` before it writes any pipeline file, from
what it read of your repository: version pins, the lockfile's package manager,
`docker-compose.yml` services, and CI install steps. It does not build the
image, so your first run is what verifies it — if that run fails early,
suspect the container before the pipeline. `boboddy init` only reports a
missing devcontainer. A pipeline made only of host steps never needs one. See
[Runtime](/boboddy/guides/steps/#runtime), or
[Set up a dev container](/boboddy/how-to/devcontainer/) to write one by
hand.

## The designer

The designer is `boboddy pipelines design`: an agent session that interviews
you about one work item and adapts the [default pipeline](#default-pipeline)
to it. Before it starts, it lists the MCP servers and skills it finds in your
repository, so it can offer those tools to your steps. It runs on a
Boboddy-managed OpenCode runtime, using an AI provider you connect once —
the same connection your steps use later. When the files typecheck, it pushes
them and offers to run the pipeline on that work item. See
[`boboddy pipelines design`](/boboddy/reference/cli/#boboddy-pipelines-design-project).

## The studio

The studio is a browser tab the designer opens: a live graph of the files it
is writing, with validation issues. It is read-only and redraws every time a
file changes. You can also open it on its own. See
[`boboddy pipelines studio`](/boboddy/reference/cli/#boboddy-pipelines-studio).

## Dashboard

The dashboard, at [app.boboddy.dev](https://app.boboddy.dev), is where runs,
logs, and traces live. It's also where you can start a run by hand from a
work item's executions drawer, and where you connect GitHub or Jira under
**Project → Settings → Integrations**.
