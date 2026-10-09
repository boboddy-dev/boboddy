# Agent Instructions: Keeping Docs Up to Date

This file tells AI agents (Claude Code, Codex, etc.) when and how to update the Boboddy documentation site in this app, `apps/docs` (package `boboddy-docs`). All paths below are relative to this app's root (`apps/docs/`) unless stated otherwise.

## When to update docs

Update the documentation whenever you make changes in these areas:

| Change area | Docs to update |
|-------------|----------------|
| New CLI command or flag | `src/content/docs/reference/cli.md` |
| Changed CLI command name, flag, or default | `src/content/docs/reference/cli.md` |
| New `defineStep`/`codeStep` option or `definePipeline` state kind | `src/content/docs/reference/sdk.mdx` + relevant guide |
| New SDK export or helper | `src/content/docs/reference/sdk.mdx` |
| New auth flow or credential storage behavior | `src/content/docs/getting-started/installation.md` |
| Product pitch, the loop, or who Boboddy is for | `src/content/docs/index.mdx` |
| New or renamed core term (project, step, signal, runtime, …) | `src/content/docs/getting-started/concepts.md` |
| A new task a user does after the Quickstart | A page in `src/content/docs/how-to/` (≤ 500 words, links to `guides/` for depth) |
| New telemetry event, opt-out mechanism, or `boboddy telemetry` flag | `src/content/docs/reference/observability.md` |
| Changes to project init flow | `src/content/docs/reference/cli.md#boboddy-init` first, then `src/content/docs/getting-started/quickstart.mdx` — the Quickstart shows only what the user types and sees |
| New step concepts (signals, computed signals, MCP) | `src/content/docs/guides/steps.md` |
| New `definePipeline()` concepts (state kinds, bindings, pipeline input) | `src/content/docs/guides/pipelines.md` |
| New `Rule`/`Computed` DSL or fan-out cohort-advancement concepts | `src/content/docs/guides/pipeline-advancement.md` |
| New default-pipeline-assignment concepts | `src/content/docs/guides/pipeline-assignment.md` |
| New worker flags | `src/content/docs/reference/cli.md#boboddy-work-projectid` |
| New worker execution behavior | `src/content/docs/guides/workers.md` |
| New dev container guidance | `src/content/docs/how-to/devcontainer.md` |
| New GitHub/Jira integration or sync behavior | `src/content/docs/how-to/integrations.md` |
| New reusable, interactive component worth showing off (not just documenting) | `src/content/docs/catalog/` — see "Adding a catalog entry" below |
| New top-level concept not fitting an existing page | Create a new page and add it to the sidebar in `astro.config.mjs` |

## One home per fact

Each fact below has one canonical page. Mention it elsewhere in one sentence and link; never copy the table.

| Fact | Canonical home |
|------|----------------|
| Provider table (which OpenCode menu entry for which AI tool) | `getting-started/quickstart.mdx` step 4 (`#connect-your-ai-tool`) |
| OpenCode is downloaded and pinned by the CLI, ~100 MB, not installed by you | `getting-started/installation.md#requirements` |
| Environment requirements (Docker, provider, login) | `getting-started/installation.md#requirements` |
| Devcontainer: the designer writes `.devcontainer/devcontainer.json` when missing (it doesn't build it); `Runtime.devcontainer()` for steps that need the code, `Runtime.host()` for steps that don't, so a first run can need Docker | `getting-started/concepts.md#runtime` |
| `.env` / `.env.example` secrets | `guides/steps.md#secrets` |
| `.opencode/` tools auto-load | `guides/steps.md#tools-already-available-to-every-step` |
| Worker flags | `reference/cli.md#boboddy-work-projectid` |
| `pull → install → typecheck → push` loop | `reference/cli.md#boboddy-pipelines-pull-projectid` / `#boboddy-pipelines-push-projectid` |
| `choice` and `routeToPipeline` | `guides/pipeline-advancement.md` |
| "Use `design` unless you want to write it yourself" | `reference/cli.md#boboddy-pipelines-init` |
| `CliError` failure codes and their meanings | `reference/cli.md#failure-codes` (`reference/observability.md` links to it) |

To check a fact has one home, search the published pages only — `rg <pattern> apps/docs/src/content/docs`. Transcripts under `src/content/transcripts/` legitimately repeat CLI output.

## Getting-started rules

- The Quickstart (`getting-started/quickstart.mdx`) is a tutorial: command → what you see → the one decision → link. Budget: ≤ 900 prose words, enforced by `bun run test` (`bun scripts/prose-words.ts <file> --max 900`). Internals belong in `reference/cli.md`.
- A new term used on a getting-started page must be defined on `concepts.md` or linked on first use.
- Quickstart transcripts (`src/content/transcripts/*.txt`) are captured, not written. Never paraphrase a reporter string; if one is wrong, fix the CLI. Each file's leading `#` lines record the CLI version and source, and `Transcript.astro` strips them when rendering.
- Today `01`–`05` are derived from the reporter strings in the `apps/cli/src` files named in their headers (not live captures); `06` replays a recorded `boboddy work` run. When you change a string in one of those files, update the transcript from the source in the same change and bump its version header. Replace a derived transcript with a live capture (e2e harness, `packages/e2e-tests/tests/setup-helpers.ts`) whenever you can.

## How to update docs

1. **Locate the right file** — use the table above. All content files live under `src/content/docs/`.
2. **Match existing style** — pages are Markdown (`.md`), or MDX (`.mdx`) where a Starlight component such as `<Tabs>`, `<Steps>`, or `<FileTree>` is needed, with a YAML frontmatter block (`title`, `description`). Code blocks use fenced syntax with the language tag. Callouts use Starlight's `:::note` / `:::tip` / `:::caution` / `:::danger` aside syntax rather than blockquotes — this works in both `.md` and `.mdx` without an import.
3. **Update tables, not prose blobs** — CLI flags and SDK options are in Markdown tables; add/remove rows rather than rewriting paragraphs.
4. **Keep examples minimal** — show the minimum code needed to illustrate the concept; avoid large copy-pasteable boilerplate blocks.
5. **Add new pages to the sidebar** — if you create a new page, add it to the relevant `items` array in `astro.config.mjs`.
6. **Run the checks** — `bun run --filter boboddy-docs test` parses every `boboddy …` line in a `bash`/`sh`/`shell`/`zsh`/`console` block with the real CLI parser (`scripts/check-commands.ts`) and enforces the Quickstart word budget. `bun run --filter boboddy-docs build` fails on a broken internal link or `#anchor` (`starlight-links-validator`). Link with absolute `/boboddy/...` paths; moving or renaming a heading changes its anchor, so the build tells you what to fix.

## File map

```
apps/docs/
├── astro.config.mjs                        ← sidebar structure, site metadata, redirects, plugins (links validator, llms.txt)
├── scripts/
│   ├── check-commands.ts                   ← `test`: every docs `boboddy …` command must parse with the CLI's yargs tree
│   └── prose-words.ts                      ← `test`: Quickstart prose word count, `--max 900`
├── src/
│   ├── content.config.ts                   ← Astro content collection config (rarely edited)
│   ├── components/
│   │   ├── CatalogExample.astro            ← shared title/description/source-disclosure chrome for catalog entries
│   │   ├── Head.astro                      ← Starlight Head override: PostHog page views + Quickstart events (docs/analytics.md)
│   │   ├── PipelineGraphIsland.astro       ← `client:visible` PipelineGraphView island, skipped when rendering llms-full.txt
│   │   └── Transcript.astro                ← renders a `src/content/transcripts/` file as a terminal block
│   └── content/
│       ├── docs/
│       │   ├── index.mdx                   ← Introduction, served at the site root /boboddy/
│       │   ├── getting-started/
│       │   │   ├── concepts.md             ← Core concepts: one definition per term
│       │   │   ├── installation.md         ← install the CLI, requirements
│       │   │   └── quickstart.mdx          ← init → design → push → run, one linear walkthrough
│       │   ├── how-to/                     ← task pages, ≤ 500 words, linking to guides/ for depth
│       │   │   ├── change-a-pipeline.md    ← re-run the designer: tweak / route / new pipeline
│       │   │   ├── let-a-step-read-your-repo.md ← host → devcontainer runtime
│       │   │   ├── connect-a-tool-to-a-step.md  ← MCP servers and their secrets via the designer
│       │   │   ├── run-on-a-work-item.md   ← queue a run, then `boboddy work`
│       │   │   ├── commit-your-pipeline.mdx ← what to commit, what's ignored, teammates
│       │   │   ├── devcontainer.md         ← writing a .devcontainer/devcontainer.json by hand
│       │   │   └── integrations.md         ← connecting GitHub/Jira, sync cadence, field mapping
│       │   ├── guides/                     ← the "SDK" sidebar group
│       │   │   ├── steps.md                ← defineStep()/codeStep() deep dive
│       │   │   ├── pipelines.md            ← definePipeline() state graph deep dive
│       │   │   ├── pipeline-advancement.md ← Rule/Computed DSL and fan-out cohort advancement
│       │   │   ├── pipeline-assignment.md  ← default-pipeline-assignment.ts routing
│       │   │   └── workers.md              ← boboddy work and worker options
│       │   ├── reference/
│       │   │   ├── cli.md                  ← complete CLI command reference
│       │   │   ├── sdk.mdx                 ← TypeScript SDK types and helpers
│       │   │   └── observability.md        ← what's collected, why, and the `boboddy telemetry` command
│       │   └── catalog/
│       │       ├── index.md                ← catalog landing page, links to every entry
│       │       └── pipeline-graph.mdx      ← pipeline graph entry (React Flow view over static fixtures)
│       ├── catalog-fixtures/               ← fixture source data for catalog entries, sibling to docs/, not a Starlight collection
│       │   └── pipeline-graph/             ← one fixture file per example on the pipeline-graph entry
│       └── transcripts/                    ← Quickstart terminal transcripts, one `.txt` per step (see "Getting-started rules")
```

## Adding a new page

1. Create `src/content/docs/<section>/<slug>.md` (or `.mdx` if the page needs a Starlight component like `<Tabs>`, `<Steps>`, or `<FileTree>`) with frontmatter:
   ```markdown
   ---
   title: Page Title
   description: One-line description
   ---
   ```
2. Add a sidebar entry in `astro.config.mjs`:
   ```javascript
   { label: 'Page Title', slug: '<section>/<slug>' }
   ```
3. Link to the new page from related existing pages where it makes sense.

## Adding a catalog entry

The catalog (`src/content/docs/catalog/`) renders real Boboddy building blocks as interactive, embedded examples, driven by hand-authored fixtures rather than a live server. Use `catalog/pipeline-graph.mdx` (plus its fixtures under `src/content/catalog-fixtures/pipeline-graph/`) as the worked reference example — read it before adding a new entry.

1. **Author fixtures** — add one or more fixture files under `src/content/catalog-fixtures/<entry-name>/`, written the way a real user would write that code (e.g. pipeline fixtures call `definePipeline()`/`defineStep()`, not the compiled `PipelineDefinitionSpec` wire-format object it produces — see `pipeline-graph/linear-chain.ts`). This directory is a sibling of `content/docs/`, not a Starlight content collection, so fixtures are plain `.ts` modules, not Markdown.
2. **Create the entry page** — `src/content/docs/catalog/<entry-name>.mdx`. It must be `.mdx`: fixtures are translated into render-ready data at build time via top-level `import`/`export const` statements, which the YAML frontmatter block (`title`/`description` only) can't hold.
3. **Wrap each example in `CatalogExample`** — import `CatalogExample` from `../../../components/CatalogExample.astro` and, for each example, pass `title`/`description` props with the interactive island as its default-slot child. Never put a React component directly in the MDX: `starlight-llms-txt` renders every page for `llms-full.txt` without a React renderer, so the build fails. Wrap it in an `.astro` component that skips the island when `Astro.url.pathname` ends in `.txt` — `PipelineGraphIsland.astro` is the pattern. Optionally add a `<pre slot="source">{fixtureSource}</pre>` sourced via a Vite `?raw` import of the fixture file, to give readers a "view fixture source" disclosure.
4. **List the entry** — add a link to `catalog/index.md`.
5. **Add it to the sidebar** — add `{ label: '<Entry Label>', slug: 'catalog/<entry-name>' }` to the `"Catalog"` section's `items` array in `astro.config.mjs`.

## Building and previewing

Run these from the monorepo root:

```bash
bun install                            # first time only
bun run docs                           # live preview at http://localhost:4321/boboddy/
bun run --filter boboddy-docs build    # production build (outputs to apps/docs/dist/)
bun run --filter boboddy-docs test     # command check + Quickstart word budget
```

## Analytics

`src/components/Head.astro` sends PostHog events only when `PUBLIC_POSTHOG_KEY` and `PUBLIC_POSTHOG_HOST` are set at build time (same as `apps/landing`). Event names live in `packages/observability/src/analytics/events.ts`; the Quickstart funnels read `step` from the enclosing `<Steps>` item, so adding a command block to a new Quickstart step means adding that step to the `docs-quickstart-commands` managed funnel (see `docs/analytics.md`).

## Deployment

This app has no CI job of its own that deploys it, and no `deploy-docs` job exists anywhere in this repo. Instead, `apps/docs` is part of the "public surface" that `scripts/publish-public.ts` rsyncs into the public mirror repo (`boboddy-dev/boboddy`), invoked by the `sync-public-mirror` job in `.github/workflows/release.yml` (via `.github/workflows/_sync-public-mirror.yml`) on every monorepo release. That job pushes the release tag to the public repo; it's the **public repo's own** `release.yml` (not present in this monorepo) that actually builds and deploys the docs site to GitHub Pages. The sync from this repo is fire-and-forget — watch the `boboddy-dev/boboddy` repo's Actions tab for the real deploy outcome, and re-run `sync-public-mirror.yml` (workflow_dispatch) to retry a failed public release.
