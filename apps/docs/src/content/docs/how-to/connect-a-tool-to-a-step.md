---
title: Give a step an MCP server
description: Ask the designer to wire a tool into a step, keep its secret out of the definition, and check it connects
---

```bash
boboddy pipelines design
```

Name the tool when the designer asks how you'd work the item — "I'd check
the error in Sentry, then query the read replica." Each tool you name either
already loads, or becomes an MCP server on the step that needs it.

## Already in `.opencode/`? Nothing to do

If your repository root has `.opencode/opencode.json` (or `.jsonc`) or
`.opencode/tools/`, the designer reads it first. Whatever it declares already
loads for every devcontainer step, so the designer says so and doesn't
redeclare it. See
[Tools already available to every step](/boboddy/guides/steps/#tools-already-available-to-every-step).

## Otherwise, the designer adds it to the step

It asks how the step reaches the tool — a launch command, a package, or a URL
— and writes it into that step's `mcpServers`:

```typescript
mcpServers: {
  postgres: {
    type: "local",
    command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
    environment: { DATABASE_URI: "{env:DATABASE_URI}" },
  },
},
```

Local, remote, and override shapes:
[MCP servers](/boboddy/guides/steps/#mcp-servers).

## Secrets: you give it a name, never a value

When the server needs a token, password, or connection string, the designer
asks only for the **environment variable name** it should come from, and
proposes one if you don't have a convention. Then it:

1. references the variable as `{env:VAR}` in the server's `environment` or
   `headers` — never the value, because definitions are pushed to the server
   and shown in the dashboard;
2. adds `VAR=` to `.boboddy/.env.example`;
3. names every variable it added when the session ends.

Your part:

```bash
cp .boboddy/.env.example .boboddy/.env
```

Fill in the real values in `.boboddy/.env`. The designer never writes that
file, and no step that uses the variable will work until you do. Keep it out
of git — see [Commit and share your pipeline](/boboddy/how-to/commit-your-pipeline/#secrets-envexample-vs-env).

Where `{env:VAR}` is resolved depends on the step's runtime: a devcontainer
step gets `.boboddy/.env`, a host step gets the worker's own environment. See
[Secrets](/boboddy/guides/steps/#secrets).

## Check it connects

After the push, dry-run the step:

```bash
boboddy work --dry-run
```

Pick the step when asked. The dry run launches its environment, starts its MCP
servers, and runs any [health checks](/boboddy/guides/steps/#health-checks) it
declares, then reports what connected — without running the step. The
designer's own post-push check covers only the pipeline's first step; see
[Dry runs](/boboddy/reference/cli/#dry-runs).
