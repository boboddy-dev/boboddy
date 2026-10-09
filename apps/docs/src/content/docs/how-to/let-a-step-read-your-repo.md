---
title: Let a step work inside your repo
description: Move a step off the host runtime so it gets a clone of your repository inside your devcontainer
---

```bash
boboddy pipelines design
```

Tell the designer which step needs your code, and what it should do with it —
read it, run the tests, or change it.

## Where a step runs

Every step has a [runtime](/boboddy/getting-started/concepts/#runtime):

- **`Runtime.devcontainer()`** — the default. The worker clones your
  repository and runs the agent inside your devcontainer.
- **`Runtime.host()`** — no clone and no Docker. The designer picks it for
  steps that only need the work item: classification, scoring, triage of the
  ticket text.

So a step that can't see your code is a host step. Your first pipeline may
have none, some, or only host steps, depending on what the designer built for
that work item. Open the pipeline file and look for
`runtime: Runtime.host()` to see which.

## Move the step into the devcontainer

In an [edit session](/boboddy/how-to/change-a-pipeline/), ask for the change
— it's a **tweak**. The designer removes the step's `Runtime.host()`, so it
falls back to `Runtime.devcontainer()`, and rewrites its prompt to use the
code. By hand it's the same edit:

```typescript
import { defineStep, Repo } from "@boboddy/sdk";

export const triage = defineStep({
  key: "triage",
  name: "Triage",
  environment: { repo: Repo.readOnly() },
  agentPrompt: "Find the code behind this report and summarize it.",
});
```

Add `repo: Repo.readOnly()`, as here, when the step only reads code; leave
`repo` off when it changes code, and its work is committed to a work branch.
See [Repo access](/boboddy/guides/steps/#repo-access).

If the repository has no `.devcontainer/devcontainer.json`, the designer
writes one in the same session, before it touches the pipeline. It doesn't
build it. To write or adjust one yourself, see
[Set up a dev container](/boboddy/how-to/devcontainer/); for a different
config per step, see
[Selecting a devcontainer config](/boboddy/guides/steps/#selecting-a-devcontainer-config).

## What you need from here

- **Docker**, running wherever `boboddy work` runs. Host steps never needed
  it; devcontainer steps do.
- **The config on your remote.** The worker reads it from the clone, so commit
  and push `.devcontainer/` on the branch you run from (see
  [Source branch](/boboddy/reference/cli/#source-branch)).
- **Secrets move too.** A devcontainer step reads `.boboddy/.env`; a host step
  reads the worker's environment. See
  [Secrets](/boboddy/guides/steps/#secrets).

## Verify it

```bash
boboddy work --dry-run
```

Pick the step when asked. The dry run brings up the same devcontainer and
OpenCode runtime a real run would and reports their health, without running
the step's prompt. Because the designer never builds the image, this — or
your next real run — is the first time it's built; if that fails, suspect the
container before the pipeline. Flags: [`boboddy work`](/boboddy/reference/cli/#boboddy-work-projectid)
and [What a dry run tests](/boboddy/reference/cli/#what-a-dry-run-tests).
