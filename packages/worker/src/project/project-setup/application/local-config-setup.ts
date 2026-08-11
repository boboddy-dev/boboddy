import type { createBoboddyClient } from "@boboddy/sdk";
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
 * - `matched` — an existing project's `gitUrl` matched this repo's remote;
 *   it's been persisted to `.boboddy/boboddy.jsonc`.
 * - `handoff-required` — no project matches this remote. This used to
 *   silently `POST /projects` to create one; it no longer does. The caller
 *   (`boboddy init`) is responsible for sending the user to `/projects/new`
 *   in a browser — pre-filled with `gitUrl`/`suggestedName` — and, once they
 *   confirm they're done, calling `completeProjectHandoff` to re-check and
 *   persist it.
 */
export type LocalConfigSetupResult =
  | { status: "already-configured" }
  | { status: "matched"; projectId: string }
  | { status: "handoff-required"; gitUrl: string; suggestedName: string };

export async function localConfigSetup(input: {
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  /** Defaults to `process.cwd()`; overridable so this is unit-testable without touching the real cwd. */
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

  const existing = await findMatchingProject({
    client: input.client,
    headers: input.headers,
    gitUrl,
  });

  if (existing) {
    await writeProjectConfig(existing.id, input.rootDir);
    logger.info(
      { projectId: existing.id },
      "Found existing project for this repository.",
    );
    return { status: "matched", projectId: existing.id };
  }

  const suggestedName = deriveProjectName(gitUrl);
  logger.info(
    { gitUrl, suggestedName },
    "No project found for this repository; a browser hand-off is required.",
  );
  return { status: "handoff-required", gitUrl, suggestedName };
}
