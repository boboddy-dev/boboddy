---
title: Run a pipeline on any work item
description: Queue a run on a work item from the dashboard or the designer's run offer, then let a worker execute it
---

```bash
boboddy work --work-item-id <id>
```

Running a pipeline takes two things: a **queued run** on the
[work item](/boboddy/getting-started/concepts/#work-item), and a
[worker](/boboddy/getting-started/concepts/#worker) to execute it. The command
above is the second half — it only claims steps already queued for that item.
With nothing queued, it just polls. Queue the run first.

## Queue it from the dashboard

1. Open your project in the
   [dashboard](/boboddy/getting-started/concepts/#dashboard) and go to the
   *Work Items* tab.
2. Open the work item and select the *Pipeline executions* button at the top
   right. A drawer lists the item's runs so far.
3. Select **New**, pick the pipeline, and select **Create**.

**New** is disabled until the project has a pushed pipeline. Once the run is
queued, start a worker with the command above, or plain `boboddy work` to
take any queued work in the project.

## Queue it from the CLI

There is no standalone command that queues a run. The closest is the run
offer at the end of a design session: run

```bash
boboddy pipelines design --work-item-id <id>
```

and when the session exits cleanly, it asks whether to run the assigned
pipeline on that item. Say yes and it queues the run and starts the worker in
the same terminal. Say no and it prints the `boboddy work … --work-item-id`
command; nothing is queued, so queue the run from the dashboard before you use
it. See [The run offer](/boboddy/reference/cli/#the-run-offer) for every case
where no offer appears.

## The worker

`boboddy work` keeps polling until you press Ctrl+C, because later steps
queue as earlier ones advance; `--once` polls once, finishes whatever it claimed, and exits.
`--work-item-id` scopes it to one item. Every flag:
[`boboddy work`](/boboddy/reference/cli/#boboddy-work-projectid). To run
several workers, see [Running Workers](/boboddy/guides/workers/).

## Why a new item doesn't start by itself

A [default pipeline assignment](/boboddy/getting-started/concepts/#default-pipeline-assignment)
is meant to start the right pipeline on every new work item. Today it is only
evaluated for items that arrive through an
[integration](/boboddy/how-to/integrations/) sync. Items created by hand —
the dashboard's create form, or a ticket you describe in the designer's
picker — are never routed, so they sit with no run until you queue one as
above. This is a known bug, tracked as issue #106, which also covers sync
skipping assignment in some configurations. Until it's fixed, queue runs for
hand-created items yourself.
