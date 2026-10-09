import type { createBoboddyClient } from "@boboddy/sdk";
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
 * While the user creates the project at `/projects/new`, `boboddy init` polls
 * this: each call is one check for a project matching the same remote and —
 * only once one exists — persists it to `.boboddy/boboddy.jsonc` at `rootDir`,
 * exactly as the fast path does. Returns `undefined` while there is still no
 * match; the caller owns the polling cadence and the timeout.
 */
export async function completeProjectHandoff(input: {
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  gitUrl: string;
  /** The repo root to write `.boboddy/` into. Defaults to `process.cwd()`. */
  rootDir?: string;
}): Promise<{ projectId: string } | undefined> {
  const match = await findMatchingProject(input);
  if (!match) {
    return undefined;
  }

  const { project } = match;
  await writeProjectConfig(project.id, input.rootDir);
  logger.info(
    { projectId: project.id, matchCount: match.matchCount },
    "Project linked via browser hand-off.",
  );
  return { projectId: project.id };
}
