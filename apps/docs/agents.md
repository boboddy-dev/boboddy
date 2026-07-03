# Agent Instructions: Keeping Docs Up to Date

This file tells AI agents (Claude Code, Codex, etc.) when and how to update the Boboddy documentation site located in this `docs/` directory.

## When to update docs

Update the documentation whenever you make changes in these areas:

| Change area | Docs to update |
|-------------|----------------|
| New CLI command or flag | `src/content/docs/reference/cli.md` |
| Changed CLI command name, flag, or default | `src/content/docs/reference/cli.md` |
| New `defineStep` / `definePipeline` option | `src/content/docs/reference/sdk.md` + relevant guide |
| New SDK export or helper | `src/content/docs/reference/sdk.md` |
| New auth flow or credential storage behavior | `src/content/docs/getting-started/installation.md` |
| Changes to project init flow | `src/content/docs/getting-started/quickstart.md` |
| New step concepts (signals, computed signals, MCP) | `src/content/docs/guides/steps.md` |
| New pipeline concepts (binding helpers, advancement rules) | `src/content/docs/guides/pipelines.md` |
| New worker flags or execution behavior | `src/content/docs/guides/workers.md` |
| New top-level concept not fitting an existing page | Create a new `.md` file and add it to the sidebar in `astro.config.mjs` |

## How to update docs

1. **Locate the right file** — use the table above. All content files live at `docs/src/content/docs/`.
2. **Match existing style** — pages use plain Markdown with a YAML frontmatter block (`title`, `description`). Code blocks use fenced syntax with the language tag.
3. **Update tables, not prose blobs** — CLI flags and SDK options are in Markdown tables; add/remove rows rather than rewriting paragraphs.
4. **Keep examples minimal** — show the minimum code needed to illustrate the concept; avoid large copy-pasteable boilerplate blocks.
5. **Add new pages to the sidebar** — if you create a new page, add it to the relevant `items` array in `docs/astro.config.mjs`.

## File map

```
docs/
├── astro.config.mjs                        ← sidebar structure, site metadata
├── src/
│   ├── content.config.ts                   ← Astro content collection config (rarely edited)
│   └── content/docs/
│       ├── index.mdx                       ← landing page hero
│       ├── getting-started/
│       │   ├── installation.md             ← install CLI, requirements, env vars
│       │   └── quickstart.md               ← step-by-step first project setup
│       ├── guides/
│       │   ├── steps.md                    ← defineStep() deep dive
│       │   ├── pipelines.md                ← definePipeline() deep dive
│       │   └── workers.md                  ← boboddy work and worker options
│       └── reference/
│           ├── cli.md                      ← complete CLI command reference
│           └── sdk.md                      ← TypeScript SDK types and helpers
```

## Adding a new page

1. Create `docs/src/content/docs/<section>/<slug>.md` with frontmatter:
   ```markdown
   ---
   title: Page Title
   description: One-line description
   ---
   ```
2. Add a sidebar entry in `docs/astro.config.mjs`:
   ```javascript
   { label: 'Page Title', slug: '<section>/<slug>' }
   ```
3. Link to the new page from related existing pages where it makes sense.

## Building and previewing

```bash
cd docs
npm install     # first time only
npm run dev     # live preview at http://localhost:4321/boboddy/
npm run build   # production build (outputs to docs/dist/)
```

The docs are automatically deployed to GitHub Pages on every release via the `deploy-docs` job in `.github/workflows/release.yml`.
