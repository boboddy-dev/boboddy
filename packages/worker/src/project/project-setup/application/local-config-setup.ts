import type { createBoboddyClient } from "@boboddy/sdk";
import { stripGitUrlCredentials } from "@boboddy/sdk/git-url";
import { createLazyLogger } from "@boboddy/observability/logging/host";
import { deriveProjectName } from "../../project-config/infra/fs-project-config-repo";
import { readProjectConfig } from "../../project-config/application/read-project-config";
import { writeProjectConfig } from "../../project-config/application/write-project-config";
import { findMatchingProject } from "./find-matching-project";
import { resolveGitRepository } from "./resolve-git-repository";

const logger = createLazyLogger({
  name: "@boboddy/worker",
  scope: "local-config-setup",
});

/**
 * The three ways `localConfigSetup` can leave things (#141):
 *
 * - `already-configured` — `.boboddy/boboddy.jsonc` already has a
 *   `projectId`; nothing else ran.
 * - `matched` — an existing project's `gitUrl` points at the same repository
 *   as this repo's remote (see `findMatchingProject`); it's been persisted to
 *   `.boboddy/boboddy.jsonc`. `matchCount` above one means several projects
 *   point at this repo and the oldest was picked.
 * - `handoff-required` — no project matches this remote. Nothing is created
 *   here. The caller (`boboddy init`) either creates the project through the
 *   API from a GitHub repo the user's installation covers, or sends the user
 *   to `/projects/new` in a browser — pre-filled with `gitUrl`/`suggestedName`
 *   — and polls `completeProjectHandoff` until it exists.
 */
export type LocalConfigSetupResult =
  | { status: "already-configured" }
  | {
      status: "matched";
      projectId: string;
      projectName: string;
      matchCount: number;
    }
  | { status: "handoff-required"; gitUrl: string; suggestedName: string };

export async function localConfigSetup(input: {
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  /**
   * The repo root `.boboddy/` lives in. Defaults to `process.cwd()`; `init`
   * passes the resolved root so a run from a subdirectory still writes there.
   */
  rootDir?: string;
}): Promise<LocalConfigSetupResult> {
  const existingConfig = await readProjectConfig(input.rootDir);
  if (existingConfig?.projectId) {
    logger.info("Local setup already complete, skipping.");
    return { status: "already-configured" };
  }

  // Same walk-up-then-remote resolution `init` reports up front — matching by
  // remote URL keeps project identity keyed by remote, not by path.
  const { remoteUrl: gitUrl } = await resolveGitRepository(input.rootDir);

  const match = await findMatchingProject({
    client: input.client,
    headers: input.headers,
    gitUrl,
  });

  if (match) {
    const { project, matchCount } = match;
    await writeProjectConfig(project.id, input.rootDir);
    logger.info(
      { projectId: project.id, matchCount },
      "Found existing project for this repository.",
    );
    return {
      status: "matched",
      projectId: project.id,
      projectName: project.name,
      matchCount,
    };
  }

  const suggestedName = deriveProjectName(gitUrl);
  logger.info(
    { gitUrl: stripGitUrlCredentials(gitUrl), suggestedName },
    "No project found for this repository; a browser hand-off is required.",
  );
  return { status: "handoff-required", gitUrl, suggestedName };
}
