import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import starlightLinksValidator from "starlight-links-validator";
import starlightLlmsTxt from "starlight-llms-txt";

// Astro's `redirects` destinations, unlike Starlight/markdown links, are not
// resolved against `base` automatically — they need the prefix spelled out.
// Kept as a constant, not a second hardcoded literal, so a future `base`
// change only needs one edit. Site structure: docs/plans/docs-onboarding-clarity.md.
const base = "/boboddy";

export default defineConfig({
  site: "https://boboddy-dev.github.io",
  base,
  redirects: {
    "/getting-started/": `${base}/`,
    "/reference/telemetry/": `${base}/reference/observability/`,
    "/guides/devcontainer/": `${base}/how-to/devcontainer/`,
    "/guides/integrations/": `${base}/how-to/integrations/`,
  },
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    react(),
    starlight({
      title: "Boboddy",
      description:
        "Distributed step execution workflows with type-safe pipelines",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/boboddy-dev/boboddy",
        },
      ],
      logo: {
        src: "./src/assets/brand-icon.svg",
        alt: "boboddy",
      },
      favicon: "/brand-icon.svg",
      editLink: {
        baseUrl: "https://github.com/boboddy-dev/boboddy-platform/edit/main/apps/docs/",
      },
      lastUpdated: true,
      /*
       * Publishes /llms.txt, /llms-full.txt, and /llms-small.txt for readers'
       * AI assistants (the Quickstart's "Have your assistant drive" tip links
       * llms-full.txt). The plugin's `exclude` only applies to llms-small.txt,
       * so the Catalog is excluded there and demoted to the end of
       * llms-full.txt; its islands are skipped by PipelineGraphIsland.astro.
       */
      plugins: [
        starlightLinksValidator(),
        starlightLlmsTxt({
          description:
            "Boboddy runs AI agents over your backlog, on your machines. You describe a pipeline — a few steps, each one an agent with a prompt and a rule for what counts as done — and a worker on your laptop or CI box runs it against each work item that arrives, pausing for a human when the rules say so.",
          promote: [
            "index",
            "getting-started/quickstart",
            "getting-started/concepts",
          ],
          demote: ["catalog", "catalog/**"],
          exclude: ["catalog", "catalog/**"],
        }),
      ],
      customCss: ["./src/styles/global.css"],
      /*
       * Expressive Code (fenced code block rendering).
       *
       * `themes: ['github-dark']` supplies syntax-highlighting (token) colors
       * only — a GitHub-Primer-derived dark Shiki theme, matching this whole
       * product's palette lineage (see design-tokens' Primer-derived
       * surfaces). Everything else here is FRAME CHROME (title bars,
       * borders, backgrounds, the copy button), authored directly from
       * `@boboddy/design-tokens` via `var(--color-*)` references — these
       * resolve at render time against the tokens imported in global.css,
       * the same "derive from tokens, don't hand-roll a palette" approach
       * used for the `@theme` ramps above.
       *
       * Providing an explicit `themes` array turns off Starlight's default
       * `useStarlightUiThemeColors` (which otherwise wires frame chrome to
       * its own `--sl-color-*` ramp) so our tokens are the single source of
       * truth. `useStarlightDarkModeSwitch: false` because this site is
       * forced dark-only (see ForcedDarkThemeProvider) — there's no light
       * variant to switch to.
       *
       * A few chrome details have no dedicated style-setting key (the
       * terminal frame's tri-color traffic-light dots, and the copy
       * button's inset bevel) — those are finished with supplementary CSS
       * in global.css, see the "Phase 4" section there.
       */
      expressiveCode: {
        themes: ["github-dark"],
        useStarlightDarkModeSwitch: false,
        styleOverrides: {
          borderColor: "var(--color-border)",
          codeBackground: "var(--color-bg)",
          codeForeground: "var(--color-text)",
          uiFontFamily: "var(--font-mono)",
          uiFontSize: "13px",
          frames: {
            // Title bar / tab bar chrome, matching the app's log viewer
            // (`background.default` + hairline border, see
            // apps/next/components/log-viewer.tsx).
            editorTabBarBackground: "var(--color-bg-header)",
            editorTabBarBorderColor: "var(--color-border)",
            editorActiveTabBackground: "var(--color-bg-header)",
            editorActiveTabForeground: "var(--color-text-muted)",
            editorActiveTabBorderColor: "var(--color-border)",
            terminalTitlebarBackground: "var(--color-bg-header)",
            terminalTitlebarForeground: "var(--color-text-muted)",
            terminalTitlebarBorderBottomColor: "var(--color-border)",
            terminalBackground: "var(--color-bg)",
            frameBoxShadowCssValue: "none",
            // Copy button, styled as the app's neutral button (see
            // apps/next/components/theme-components-controls.ts's
            // `contained` recipe). Idle opacity is raised to 1 so the
            // button reads as a filled neutral button at rest, not (EC's
            // default) a ghost button that only appears on hover.
            inlineButtonBackground: "#21262d",
            inlineButtonBackgroundIdleOpacity: "1",
            inlineButtonBackgroundHoverOrFocusOpacity: "1",
            inlineButtonBackgroundActiveOpacity: "1",
            inlineButtonForeground: "var(--color-text-muted)",
            inlineButtonBorder: "rgba(240, 246, 252, 0.1)",
            inlineButtonBorderOpacity: "1",
          },
        },
      },
      components: {
        ThemeSelect: "./src/components/EmptyThemeSelect.astro",
        ThemeProvider: "./src/components/ForcedDarkThemeProvider.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        Header: "./src/components/Header.astro",
        Head: "./src/components/Head.astro",
      },
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap",
          },
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "index" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
            { label: "Core concepts", slug: "getting-started/concepts" },
            { label: "Installation", slug: "getting-started/installation" },
          ],
        },
        {
          label: "How-to",
          items: [
            {
              label: "Change the pipeline you built",
              slug: "how-to/change-a-pipeline",
            },
            {
              label: "Let a step work inside your repo",
              slug: "how-to/let-a-step-read-your-repo",
            },
            {
              label: "Give a step an MCP server",
              slug: "how-to/connect-a-tool-to-a-step",
            },
            {
              label: "Run a pipeline on any work item",
              slug: "how-to/run-on-a-work-item",
            },
            {
              label: "Commit and share your pipeline",
              slug: "how-to/commit-your-pipeline",
            },
            { label: "Set up a dev container", slug: "how-to/devcontainer" },
            { label: "Connect GitHub or Jira", slug: "how-to/integrations" },
          ],
        },
        {
          label: "SDK",
          items: [
            { label: "Defining Steps", slug: "guides/steps" },
            { label: "Building Pipelines", slug: "guides/pipelines" },
            {
              label: "Pipeline Advancement",
              slug: "guides/pipeline-advancement",
            },
            {
              label: "Default Pipeline Assignment",
              slug: "guides/pipeline-assignment",
            },
            { label: "Running Workers", slug: "guides/workers" },
          ],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
        {
          label: "Catalog",
          items: [
            { label: "Overview", slug: "catalog" },
            { label: "Pipeline Graph", slug: "catalog/pipeline-graph" },
          ],
        },
      ],
    }),
  ],
});
