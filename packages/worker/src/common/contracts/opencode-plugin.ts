/**
 * A single entry in the OpenCode `plugin` config array.
 * Either a package name string or a [packageName, options] tuple.
 */
export type OpenCodePluginEntry =
  | string
  | [string, Record<string, unknown>];

/** Full value of the OpenCode `plugin` config field — an ordered list of npm plugin entries. */
export type OpenCodePlugins = OpenCodePluginEntry[];
