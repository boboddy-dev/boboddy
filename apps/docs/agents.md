# Agent Instructions: Keeping Docs Up to Date

This file tells AI agents (Claude Code, Codex, etc.) when and how to update the Boboddy documentation site in this app, `apps/docs` (package `boboddy-docs`). All paths below are relative to this app's root (`apps/docs/`) unless stated otherwise.

## When to update docs

Update the documentation whenever you make changes in these areas:

| Change area | Docs to update |
|-------------|----------------|
| New CLI command or flag | `src/content/docs/reference/cli.md` |
| Changed CLI command name, flag, or default | `src/content/docs/reference/cli.md` |
| New `defineStep` / `pipeline()` builder option | `src/content/docs/reference/sdk.mdx` + relevant guide |
| New SDK export or helper | `src/content/docs/reference/sdk.mdx` |
| New auth flow or credential storage behavior | `src/content/docs/getting-started/installation.mdx` |
| Changes to project init flow | `src/content/docs/getting-started/quickstart.mdx` |
| New step concepts (signals, computed signals, MCP) | `src/content/docs/guides/steps.md` |
| New `pipeline()` builder concepts (bindings, `.step()`/`.build()` options) | `src/content/docs/guides/pipelines.md` |
| New advancement policy or computed-signal concepts | `src/content/docs/guides/pipeline-advancement.md` |
| New default-pipeline-assignment concepts | `src/content/docs/guides/pipeline-assignment.md` |
| New worker flags or execution behavior | `src/content/docs/guides/workers.md` |
| New dev container guidance | `src/content/docs/guides/devcontainer.md` |
| New top-level concept not fitting an existing page | Create a new page and add it to the sidebar in `astro.config.mjs` |

## How to update docs

1. **Locate the right file** — use the table above. All content files live under `src/content/docs/`.
2. **Match existing style** — pages are Markdown (`.md`), or MDX (`.mdx`) where a Starlight component such as `<Tabs>`, `<Steps>`, or `<FileTree>` is needed, with a YAML frontmatter block (`title`, `description`). Code blocks use fenced syntax with the language tag. Callouts use Starlight's `:::note` / `:::tip` / `:::caution` / `:::danger` aside syntax rather than blockquotes — this works in both `.md` and `.mdx` without an import.
3. **Update tables, not prose blobs** — CLI flags and SDK options are in Markdown tables; add/remove rows rather than rewriting paragraphs.
4. **Keep examples minimal** — show the minimum code needed to illustrate the concept; avoid large copy-pasteable boilerplate blocks.
5. **Add new pages to the sidebar** — if you create a new page, add it to the relevant `items` array in `astro.config.mjs`.

## File map

```
apps/docs/
├── astro.config.mjs                        ← sidebar structure, site metadata, "/" redirect
├── src/
│   ├── content.config.ts                   ← Astro content collection config (rarely edited)
│   └── content/docs/
│       ├── getting-started/
│       │   ├── installation.mdx            ← install CLI, requirements, env vars
│       │   └── quickstart.mdx              ← step-by-step first project setup
│       ├── guides/
│       │   ├── steps.md                    ← defineStep() deep dive
│       │   ├── pipelines.md                ← pipeline() builder deep dive
│       │   ├── pipeline-advancement.md     ← advancement policies and computed signals
│       │   ├── pipeline-assignment.md      ← default-pipeline-assignment.ts routing
│       │   ├── workers.md                  ← boboddy work and worker options
│       │   └── devcontainer.md             ← writing a .devcontainer/devcontainer.json by hand
│       └── reference/
│           ├── cli.md                      ← complete CLI command reference
│           └── sdk.mdx                     ← TypeScript SDK types and helpers
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

## Building and previewing

Run these from the monorepo root:

```bash
bun install                            # first time only
bun run docs                           # live preview at http://localhost:4321/boboddy/
bun run --filter boboddy-docs build    # production build (outputs to apps/docs/dist/)
```

## Deployment

This app has no CI job of its own that deploys it, and no `deploy-docs` job exists anywhere in this repo. Instead, `apps/docs` is part of the "public surface" that `scripts/publish-public.ts` rsyncs into the public mirror repo (`boboddy-dev/boboddy`), invoked by the `sync-public-mirror` job in `.github/workflows/release.yml` (via `.github/workflows/_sync-public-mirror.yml`) on every monorepo release. That job pushes the release tag to the public repo; it's the **public repo's own** `release.yml` (not present in this monorepo) that actually builds and deploys the docs site to GitHub Pages. The sync from this repo is fire-and-forget — watch the `boboddy-dev/boboddy` repo's Actions tab for the real deploy outcome, and re-run `sync-public-mirror.yml` (workflow_dispatch) to retry a failed public release.
