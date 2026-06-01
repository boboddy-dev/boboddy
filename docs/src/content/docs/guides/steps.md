---
title: Defining Steps
description: Create reusable, versioned computation units with typed inputs, outputs, and signals
---

A **step** is the atomic unit of work in Boboddy. Each step has a typed input schema, a result schema, an agent prompt, and optionally a set of **signals** extracted from its output.

## Basic step

```typescript
import { defineStep } from '@boboddy/sdk';
import { z } from 'zod';

export const summarizeStep = defineStep({
  key: 'summarize-text',
  name: 'Summarize Text',
  agentPrompt: 'Summarize the provided text concisely.',
  input: z.object({
    text: z.string(),
  }),
  result: z.object({
    summary: z.string(),
  }),
  status: 'active',
});
```

## `defineStep` options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | `string` | Yes | Unique identifier for this step within the project |
| `name` | `string` | Yes | Human-readable display name |
| `version` | `number` | No | Version number (defaults to 1) |
| `description` | `string` | No | Brief description shown in the UI |
| `agentPrompt` | `string` | Yes | AI prompt given to the worker agent when executing this step |
| `input` | `ZodType` | No | Zod schema for the step's input payload |
| `additionalStepInput` | `object` | No | Default work item field and literal bindings for this step |
| `result` | `ZodType` | No | Zod schema for the step's output |
| `signals` | `Signal[]` | No | Values to extract from the result for pipeline advancement logic |
| `computedSignals` | `ComputedSignal[]` | No | Aggregated signals derived from multiple raw signals |
| `mcpServers` | `OpenCodeMcpServers` | No | MCP server configurations for tool-using agents |
| `status` | `"draft" \| "active"` | No | Draft steps are not executed; defaults to `"active"` |

## Signals

Signals are scalar values (numbers, strings, booleans) extracted from the step result. They drive pipeline advancement policies — e.g., "only advance to the next step if `clarity_score` is above 7".

```typescript
export const reviewStep = defineStep({
  key: 'code-review',
  name: 'Code Review',
  result: z.object({
    feedback: z.string(),
    quality: z.number(),
    security: z.number(),
  }),
  signals: [
    { sourcePath: 'quality', key: 'quality_score', type: 'number', required: true },
    { sourcePath: 'security', key: 'security_score', type: 'number', required: true },
  ],
  // ...
});
```

### Signal options

| Field | Type | Description |
|-------|------|-------------|
| `sourcePath` | `string` | Dot-notation path into the result object (e.g., `"metrics.score"`) |
| `key` | `string` | Signal name used in pipeline advancement rules |
| `type` | `"number" \| "string" \| "boolean"` | Expected type |
| `required` | `boolean` | If true, a missing value causes the execution to fail |

## Computed signals

Computed signals aggregate multiple raw signals into a single derived value.

```typescript
computedSignals: [
  {
    key: 'average_score',
    type: 'average',
    inputSignalKeys: ['quality_score', 'security_score'],
  },
],
```

## MCP servers

Steps can be given access to MCP (Model Context Protocol) servers, giving the agent tools like file access, web browsing, or custom APIs.

```typescript
mcpServers: {
  filesystem: {
    type: 'local',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
  },
},
```

## Versioning

Increment `version` when you make a breaking change to a step's schema or prompt. Old executions referencing version 1 continue using the v1 definition; new executions pick up v2.

```typescript
export const reviewStep = defineStep({
  key: 'code-review',
  version: 2,
  // ...
});
```

## Pushing steps

Steps are pushed together with pipeline definitions using a single command from `.boboddy/pipeline-builder/`:

```bash
boboddy pipelines push
```

This pushes all steps exported from `steps.ts` (and any steps embedded in pipeline files) before pushing the pipeline definitions. The `key` + `version` pair uniquely identifies each step definition on the server.
