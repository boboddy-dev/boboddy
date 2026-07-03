import { access } from "node:fs/promises";
import path from "node:path";
import { ConfigurationError } from "../../../lib/errors";
import { createLazyLogger } from "../../../lib/logger";

const DEVCONTAINER_CONFIG_CANDIDATES = [
  ".devcontainer/devcontainer.json",
  "devcontainer.json",
] as const;

const logger = createLazyLogger({
  name: "@boboddy/worker",
  scope: "ensure-devcontainer",
});

export async function hasDevcontainer(rootDir: string): Promise<boolean> {
  for (const candidate of DEVCONTAINER_CONFIG_CANDIDATES) {
    try {
      await access(path.join(rootDir, candidate));
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

/**
 * Require the project to already provide a devcontainer config. Boboddy runs
 * OpenCode inside the user's devcontainer, so a `.devcontainer/devcontainer.json`
 * must exist. Throws a {@link ConfigurationError} with actionable guidance when
 * one is missing; the CLI surfaces the message without a stack trace.
 */
export async function requireDevcontainer(rootDir: string): Promise<void> {
  if (await hasDevcontainer(rootDir)) {
    logger.info("Devcontainer config found.");
    return;
  }

  throw new ConfigurationError(
    "No devcontainer found. Boboddy runs inside your project's devcontainer. " +
      "Add a `.devcontainer/devcontainer.json` to this repo and re-run " +
      "`boboddy init`.",
    "DEVCONTAINER_MISSING",
  );
}
