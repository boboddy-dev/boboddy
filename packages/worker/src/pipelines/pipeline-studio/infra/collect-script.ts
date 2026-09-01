// Bun's `with { type: "text" }` import attribute inlines the template at
// build time, so the bun-compile binary carries the script source as a string.
import template from "./collect-script.ts.tmpl" with { type: "text" };

export const COLLECT_SCRIPT_FILENAME = ".boboddy-studio-collect.mjs";
export const COLLECT_SCRIPT_TEMPLATE = template;
