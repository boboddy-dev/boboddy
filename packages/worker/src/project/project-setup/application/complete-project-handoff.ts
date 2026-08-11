import type { createBoboddyClient } from "@boboddy/sdk";
import { ConfigurationError } from "../../../lib/errors";
import { createLazyLogger } from "@boboddy/observability/logging/host";
import { writeProjectConfig } from "../../project-config/application/write-project-config";
import { findMatchingProject } from "./find-matching-project";

const logger = createLazyLogger({
  name: "@boboddy/worker",
  scope: "complete-project-handoff",
});

/**
 * The other half of the browser hand-off `localConfigSetup` starts (#141).
 *
 * Once the user has (hopefully) finished creating the project at
 * `/projects/new` and pressed Enter to continue, this re-checks the server
 * for a project matching the same remote and — only once one exists —
 * persists it to `.boboddy/boboddy.jsonc`, exactly as the fast path does.
 *
 * Throws when the repository still cannot be matched: the user backed out,
 * hasn't finished yet, or created it with a different remote. This is not
 * polling — it is a single, explicit re-check gated on the user's keypress.
 */
export async function completeProjectHandoff(input: {
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  gitUrl: string;
  /** Defaults to `process.cwd()`; overridable so this is unit-testable without touching the real cwd. */
  rootDir?: string;
}): Promise<{ projectId: string }> {
  const existing = await findMatchingProject(input);
  if (!existing) {
    throw new ConfigurationError(
      "Still no project found for this repository. Finish creating it at " +
        "the page that opened, then run `boboddy init` again.",
    );
  }

  await writeProjectConfig(existing.id, input.rootDir);
  logger.info(
    { projectId: existing.id },
    "Project linked via browser hand-off.",
  );
  return { projectId: existing.id };
}
