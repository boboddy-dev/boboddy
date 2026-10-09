# @boboddy/cli

Boboddy runs AI agents over your backlog, on your machines. This CLI links your
repo, designs pipelines with an agent, and runs the workers that execute them.

## Install

```sh
npm i -g @boboddy/cli
```

## Use

```sh
boboddy init               # sign in and link this repo to a Boboddy project
boboddy pipelines design   # pick a work item; an agent interviews you and writes the pipeline
boboddy work               # run a worker that executes your pipeline's steps
```

The designer connects to an AI provider once, the first time it starts. The
Quickstart says
[which option to pick for your tool](https://boboddy-dev.github.io/boboddy/getting-started/quickstart/#connect-your-ai-tool).

## Docs

- [Quickstart](https://boboddy-dev.github.io/boboddy/getting-started/quickstart/) — ten minutes to a running pipeline.
- [CLI reference](https://boboddy-dev.github.io/boboddy/reference/cli/) — every command and flag.
- [Observability](https://boboddy-dev.github.io/boboddy/reference/observability/) — what the CLI reports and how to opt out.
