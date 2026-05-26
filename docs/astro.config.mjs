import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://boboddy-dev.github.io",
  base: "/boboddy",
  integrations: [
    starlight({
      title: "Boboddy",
      description:
        "Distributed step execution workflows with type-safe pipelines",
      social: {
        github: "https://github.com/boboddy-dev/boboddy",
      },
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
            { label: "Running Workers", slug: "guides/workers" },
            {
              label: "Setting up a Dev Container",
              slug: "guides/devcontainer",
            },
          ],
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
      ],
    }),
  ],
});
