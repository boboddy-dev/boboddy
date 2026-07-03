---
title: Quickstart
description: Initialize a project, define a step, and run your first worker
---

This guide walks you through creating a Boboddy project, defining steps and a pipeline, and running a worker to execute it.

## 1. Initialize your project

Run `boboddy init` inside your repository. The interactive setup will:

1. Authenticate you (if not already logged in)
2. Create or select a project on the server
3. Generate `.devcontainer/devcontainer.json` for your repo
4. Recommend pipeline structures based on your codebase

```bash
cd my-repo
boboddy init
```

This creates `.boboddy/boboddy.jsonc` with your `projectId`.

## 2. Scaffold the pipeline builder

```bash
boboddy pipelines pull
```

This fetches your existing step and pipeline definitions from the server and writes them into `.boboddy/pipeline-builder/` as editable TypeScript files. For a brand-new project with nothing on the server yet, use `boboddy pipelines init` instead to get a starter template.

Then install dependencies:

```bash
cd .boboddy/pipeline-builder
npm install   # or bun install
```

## 3. Define your steps and pipeline

Edit `steps.ts` to define your steps:

```typescript
import { defineStep } from "@boboddy/sdk/definitions/steps";
import { z } from "zod";

export const reviewCodeStep = defineStep({
  key: "review-code",
  name: "Review Code",
  description: "Analyze a code snippet and return a clarity score.",
  agentPrompt: ({ input, boboddy }) => `
Review the provided code snippet.
Language: ${input.language}
Return structured feedback and a clarity score from 0 to 10.
If you generate any files, write them to ${boboddy.artifactsDir}.
`,
  additionalInput: z.object({
    code: z.string(),
    language: z.string().optional(),
  }),
  result: z.object({
    feedback: z.string(),
    score: z.number().min(0).max(10),
  }),
  signals: [
    {
      sourcePath: "score",
      key: "clarity_score",
      type: "number",
      required: true,
    },
  ],
  status: "active",
});
```

Then wire steps into a pipeline in the corresponding `<pipeline-key>.ts` file. See [Defining Steps](/boboddy/guides/steps/) and [Building Pipelines](/boboddy/guides/pipelines/) for full details.

## 4. Push your definitions

Upload both steps and pipeline definitions to the server in one command:

```bash
boboddy pipelines push
```

Pass an explicit project ID if you're outside a project directory:

```bash
boboddy pipelines push <projectId>
```

## 5. Run a worker

Start a worker on any machine with Docker:

```bash
boboddy work
```

The worker polls for pending step executions, claims them, runs them inside your devcontainer environment, and reports results back. See [Running Workers](/boboddy/guides/workers/) for all worker options.

## Project structure

After completing setup, your repo will have:

```
my-repo/
├── .boboddy/
│   ├── boboddy.jsonc              # project config (projectId)
│   └── pipeline-builder/          # steps and pipeline definitions
│       ├── package.json
│       ├── tsconfig.json
│       ├── .gitignore
│       ├── steps.ts               # all step definitions
│       └── <pipeline-key>.ts      # one file per pipeline
└── .devcontainer/
    └── devcontainer.json          # execution environment
```
