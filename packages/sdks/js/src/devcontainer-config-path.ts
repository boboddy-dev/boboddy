import { z } from "zod";

/**
 * Wire schema for a step's selected devcontainer config
 * (`devcontainerConfigPath`): the full repo-relative path to the file the worker
 * launches instead of searching for one.
 *
 * - Repo-relative: no leading `/`, no drive letter, no backslash, no `..`
 *   segment. A leading `./` is normalized away (`normalizeDevcontainerConfigPath`).
 * - The basename is `devcontainer.json` or `.devcontainer.json`, the
 *   devcontainer CLI's own rule for `--config`.
 * - At most 255 characters.
 *
 * Containment against symlinks is a runtime concern the worker re-checks with
 * `realpath`; this schema is purely lexical.
 */

export const MAX_DEVCONTAINER_CONFIG_PATH_LENGTH = 255;

export const DEVCONTAINER_CONFIG_BASENAMES: readonly string[] = [
  "devcontainer.json",
  ".devcontainer.json",
];

const LEADING_CURRENT_DIR = /^(?:\.\/)+/;
const DRIVE_LETTER = /^[A-Za-z]:/;

/** Strips any leading `./` segments. Leaves every other character untouched. */
export function normalizeDevcontainerConfigPath(path: string): string {
  return path.replace(LEADING_CURRENT_DIR, "");
}

function basenameOf(path: string): string {
  return path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
}

export const devcontainerConfigPathSchema = z
  .string()
  .max(MAX_DEVCONTAINER_CONFIG_PATH_LENGTH)
  .overwrite(normalizeDevcontainerConfigPath)
  .refine((path) => !path.includes("\\"), {
    message: "must use forward slashes, not backslashes",
  })
  .refine((path) => !path.startsWith("/") && !DRIVE_LETTER.test(path), {
    message: "must be relative to the repository root, not absolute",
  })
  .refine((path) => !path.split("/").includes(".."), {
    message: 'must not contain a ".." segment',
  })
  .refine((path) => DEVCONTAINER_CONFIG_BASENAMES.includes(basenameOf(path)), {
    message: 'must end in "devcontainer.json" or ".devcontainer.json"',
  });

export type DevcontainerConfigPath = z.output<
  typeof devcontainerConfigPathSchema
>;
