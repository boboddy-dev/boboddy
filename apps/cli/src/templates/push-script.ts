// Bun's `with { type: "text" }` import attribute inlines the template at
// build time, so the bun-compile binary carries the script source as a string.
import template from "./push-script.ts.tmpl" with { type: "text" };

export const PUSH_SCRIPT_FILENAME = "push.ts";
export const PUSH_SCRIPT_TEMPLATE = template;
