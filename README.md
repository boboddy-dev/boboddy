# boboddy

### Business Oriented Bug Optimization & Diagnostic Deployment sYstem

Run AI agents on your codebase as multi-step, type-safe pipelines — on your own machines, with your own AI provider.

You define **steps** (typed units of work) and chain them into **pipelines**. Each step runs inside a Docker container with an AI agent, and emits **signals** — simple metrics that decide whether the pipeline moves on, retries, or stops. No glue code, no custom orchestration to maintain.

## Why boboddy

- **Your infrastructure, your rules.** Workers run on machines you control, using an AI provider you choose. Your code and data never touch a third-party execution environment.
- **Built for scale, not scripts.** Pipelines are type-safe and composable, so multi-step AI workflows stay reliable as they grow.
- **Signal-driven, not brittle.** Advancement is decided by extracted metrics from each step's output, not fragile string-matching or manual review.
- **See everything.** A web dashboard shows pipeline runs, step outputs, and history in one place.

## Use cases

- Automatically reproduce and diagnose bugs pulled in from GitHub or Jira issues.
- Run multi-stage AI review/refactor pipelines across a codebase.
- Process a backlog of work items with a consistent, auditable pipeline.
- Any repeatable, multi-step task you'd want an AI agent to own end-to-end, without giving up control of where it runs.

---

**[boboddy.dev](https://boboddy.dev)** — [Docs](https://boboddy-dev.github.io/boboddy/)
