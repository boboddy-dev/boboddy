---
title: Change the pipeline you built
description: Re-run the designer on another work item to tweak a pipeline, route items to it, or add a new one
---

```bash
boboddy pipelines design --work-item-id <id>
```

Run the designer again, from anywhere in your repository, on a work item the
current pipeline handles badly — or leave off `--work-item-id` and pick one
(see [Choosing a work item](/boboddy/reference/cli/#choosing-a-work-item)).
It's the same command you used on day one. It doesn't start over; it edits
what's there.

## What the designer reads first

Before it asks you anything, the designer reads every definition in
`.boboddy/pipeline-builder/`, summarizes each pipeline in a line, and notes
where they already overlap the item you picked. If the last session's
[post-push dry run](/boboddy/reference/cli/#dry-runs) failed, it raises that
first and fixes it before anything else.

It only reads the local files. If a teammate pushed definitions that aren't in
your checkout, pull them first with
[`boboddy pipelines pull`](/boboddy/reference/cli/#boboddy-pipelines-pull-projectid).

## Agree on the size of the change

Before it touches a file, the designer states one verdict and waits for your
yes:

| Verdict          | What changes                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **tweak**        | An existing pipeline: its prompts, a gate, an added step                                          |
| **route**        | `default-pipeline-assignment.ts`, or a `route(...)` outcome, so items like this one reach an existing pipeline |
| **new pipeline** | A new file, for a class of work item that needs a genuinely different shape                      |

It prefers them in that order, and a pipeline that would duplicate most of an
existing one's steps counts as a tweak or a route. If you disagree, say so — it
takes your verdict over its own. Details:
[Edit sessions](/boboddy/reference/cli/#edit-sessions).

## Watch it change

The [studio](/boboddy/reference/cli/#the-studio) opens again and redraws the
graph each time the designer saves a file, with the same validation issues
`boboddy pipelines push` would report. When the definitions typecheck, the
designer pushes them — `push` always asks first.

## Fix a run that failed

The edit loop is the repair loop. When a step fails or the devcontainer won't
build, run `boboddy pipelines design` again and tell the designer what
happened — paste the error or point it at the run in the dashboard. See
[The run offer](/boboddy/reference/cli/#the-run-offer).

## Edit by hand instead

The files are plain TypeScript. Edit them in your editor, run
`npm run typecheck` (or your package manager's equivalent) inside
`.boboddy/pipeline-builder/`, then:

```bash
boboddy pipelines push
```

For what you can write, see [Defining Steps](/boboddy/guides/steps/),
[Building Pipelines](/boboddy/guides/pipelines/), and
[Default Pipeline Assignment](/boboddy/guides/pipeline-assignment/). Then
[commit your changes](/boboddy/how-to/commit-your-pipeline/).
