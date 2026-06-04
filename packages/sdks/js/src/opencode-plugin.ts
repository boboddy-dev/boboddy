import { z } from "zod";

/**
 * A single entry in the OpenCode `plugin` config field.
 * Mirrors the OpenCode config.json schema:
 *   - string: npm package name, e.g. "opencode-wakatime"
 *   - [string, object]: package name + options object, e.g. ["@my-org/plugin", { key: "val" }]
 */
export const openCodePluginEntrySchema = z.union([
  z.string().trim().min(1),
  z
    .tuple([z.string().trim().min(1), z.record(z.string(), z.unknown())])
    .rest(z.never()),
]);

/**
 * The full value of the OpenCode `plugin` config array.
 */
export const openCodePluginsSchema = z.array(openCodePluginEntrySchema);

export type OpenCodePluginEntry = z.infer<typeof openCodePluginEntrySchema>;
export type OpenCodePlugins = z.infer<typeof openCodePluginsSchema>;
