import { access } from "node:fs/promises";
import path from "node:path";
import { createLazyLogger } from "../../../lib/logger";

/**
 * The config path Boboddy asks for when one has to be created — the canonical
 * spelling, and the only one the pipeline designer is permitted to write.
 *
 * Load-bearing in two places across two packages: the candidate list below, and
 * the designer agent's `edit` allowlist
 * (`PIPELINE_DESIGNER_EDIT_PERMISSIONS`), whose pattern must cover it. A test
 * asserts the two still agree.
 */
export const DEVCONTAINER_CONFIG_PATH = ".devcontainer/devcontainer.json";

/**
 * Both spellings the devcontainer CLI accepts. Detection stays generous — a repo
 * that already uses the root-level form is not missing a devcontainer — even
 * though {@link DEVCONTAINER_CONFIG_PATH} is what we would create.
 */
const DEVCONTAINER_CONFIG_CANDIDATES = [
  DEVCONTAINER_CONFIG_PATH,
  "devcontainer.json",
] as const;

const logger = createLazyLogger({
  name: "@boboddy/worker",
  scope: "ensure-devcontainer",
});

/**
 * Does this repository already carry a devcontainer config?
 *
 * Deliberately a question, not an assertion: a missing devcontainer no longer
 * blocks onboarding. `boboddy init` reports it as a notice and the pipeline
 * designer authors one in-session, so every caller wants the boolean.
 */
export async function hasDevcontainer(rootDir: string): Promise<boolean> {
  for (const candidate of DEVCONTAINER_CONFIG_CANDIDATES) {
    try {
      await access(path.join(rootDir, candidate));
      logger.info({ candidate }, "Devcontainer config found.");
      return true;
    } catch {
      // try next
    }
  }
  logger.info("No devcontainer config found.");
  return false;
}
