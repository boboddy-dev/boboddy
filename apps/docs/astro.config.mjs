import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";

// Astro's `redirects` destinations, unlike Starlight/markdown links, are not
// resolved against `base` automatically — they need the prefix spelled out
// (see open question 2 in docs/docs-site-redesign-plan.md re: base-path
// fragility). Kept as a constant, not a second hardcoded literal, so a
// future `base` change only needs one edit.
const base = "/boboddy";

export default defineConfig({
  site: "https://boboddy-dev.github.io",
  base,
  // No docs-home splash page: send visitors straight into the first guide
  // instead of a marketing-style landing page.
  redirects: {
    "/": `${base}/getting-started/installation/`,
  },
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
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
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
          ],
        },
        {
          label: "Guides",
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
            {
              label: "Setting up a Dev Container",
              slug: "guides/devcontainer",
            },
          ],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
      ],
    }),
  ],
});
