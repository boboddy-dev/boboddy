---
title: SDK Reference
description: TypeScript SDK types, helpers, and API client
---

Install the SDK:

```bash
npm install @boboddy/sdk
# or
bun add @boboddy/sdk
```

---

## `defineStep(options)`

Define a reusable, versioned step with typed input/output schemas.

```typescript
import { defineStep } from '@boboddy/sdk';
import { z } from 'zod';

const myStep = defineStep({
  key: 'my-step',
  name: 'My Step',
  version: 1,
  description: 'Does something useful.',
  input: z.object({ text: z.string() }),
  result: z.object({ summary: z.string(), score: z.number() }),
  signals: [
    { sourcePath: 'score', key: 'quality_score', type: 'number', required: true },
  ],
  prompt: 'Analyze the provided text and return a summary and quality score.',
  status: 'active',
});
```

### `StepDefinition` options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | `string` | Yes | Unique step key within the project |
| `name` | `string` | Yes | Display name |
| `version` | `number` | No | Version (default: `1`) |
| `description` | `string` | No | Short description |
| `prompt` | `string` | No | AI instruction given to the executing agent |
| `input` | `ZodType` | No | Input payload schema |
| `result` | `ZodType` | No | Output payload schema |
| `signals` | `Signal[]` | No | Values to extract from the result |
| `computedSignals` | `ComputedSignal[]` | No | Derived aggregate signals |
| `mcpServers` | `OpenCodeMcpServers` | No | MCP server configs for tool-using agents |
| `status` | `"draft" \| "active"` | No | Draft steps are skipped by workers |

### `Signal`

```typescript
type Signal = {
  sourcePath: string;        // dot-notation path into result, e.g. "metrics.score"
  key?: string;              // signal name used in advancement rules
  type?: 'number' | 'string' | 'boolean';
  required?: boolean;        // fail execution if signal is missing
};
```

### `ComputedSignal`

```typescript
type ComputedSignal = {
  key: string;               // signal name
  type: 'average';           // aggregation function
  inputSignalKeys: string[]; // source signal keys to aggregate
};
```

---

## `definePipeline(options)`

Define an ordered sequence of steps with typed input bindings and advancement policies.

```typescript
import { definePipeline, fromPipelineInput } from '@boboddy/sdk';
import { z } from 'zod';

const myPipeline = definePipeline({
  key: 'my-pipeline',
  name: 'My Pipeline',
  status: 'active',
  steps: [
    {
      step: myStep,
      input: {
        text: fromPipelineInput(z.string(), 'text'),
      },
    },
  ],
});
```

### `PipelineDefinition` options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | `string` | Yes | Unique pipeline key |
| `name` | `string` | Yes | Display name |
| `version` | `number` | No | Version (default: `1`) |
| `description` | `string` | No | Short description |
| `status` | `"draft" \| "active"` | No | Draft pipelines are not executed |
| `steps` | `PipelineStep[]` | Yes | Ordered step entries |

### `PipelineStep`

| Field | Type | Description |
|-------|------|-------------|
| `step` | `TypedStepDefinitionSpec` | Step definition returned by `defineStep` |
| `input` | `InputBindingMap` | Map of input field names to binding helpers |
| `timeout` | `number` | Milliseconds before the step is marked timed out |
| `advancement` | `Rule<SignalKeys>` | Boolean signal rule; pipeline halts if not satisfied |

---

## Input binding helpers

### `fromPipelineInput(schema, path)`

Bind a step input field to a top-level pipeline input parameter.

```typescript
input: {
  code: fromPipelineInput(z.string(), 'code'),
}
```

### `fromSignal(step, signalKey)`

Bind a step input field to a signal emitted by a prior step in the pipeline.

```typescript
input: {
  previousScore: fromSignal(reviewStep, 'clarity_score'),
}
```

### `stepOutput(step)`

Bind a step input field to the complete output object of a prior step.

```typescript
input: {
  reviewResult: stepOutput(reviewStep),
}
```

---

## API client

The SDK ships an auto-generated API client built from the OpenAPI spec.

```typescript
import { createBoboddyClient } from '@boboddy/sdk';

const client = createBoboddyClient('https://app.boboddy.dev');
```

Use `createStepDefinitionsClient` for CRUD operations on step definitions:

```typescript
import { createStepDefinitionsClient } from '@boboddy/sdk';

const stepClient = createStepDefinitionsClient('https://app.boboddy.dev');
```

---

## Config helpers

### JSONC parser

Parse `.boboddy/boboddy.jsonc` files (JSON with comments):

```typescript
import { parseJsonc } from '@boboddy/sdk';

const config = parseJsonc(rawString);
```

### Project config

Read the Boboddy project config from disk:

```typescript
import { readProjectConfig } from '@boboddy/sdk';

const { projectId } = await readProjectConfig();
```
