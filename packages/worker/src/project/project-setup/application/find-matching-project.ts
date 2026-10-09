import type { createBoboddyClient } from "@boboddy/sdk";
import { isSameGitRepo } from "@boboddy/sdk/git-url";
import { ConfigurationError } from "../../../lib/errors";

/** The subset of a project record this lookup cares about. */
export interface MatchedProject {
  id: string;
  name: string;
  gitUrl: string;
  createdAt: string;
}

/**
 * The project chosen for a repository. `matchCount` is how many of the
 * caller's projects point at the same repository; when it is above one, the
 * oldest (then lowest id) wins so repeated runs always pick the same one.
 */
export interface ProjectMatch {
  project: MatchedProject;
  matchCount: number;
}

/**
 * Look up the project (if any) whose `gitUrl` points at the same repository
 * as this one's remote, comparing normalized identity keys so an SSH remote
 * matches a project stored with the HTTPS URL. Shared by
 * {@link localConfigSetup}'s initial check and `completeProjectHandoff`'s
 * re-check after the user finishes creating a project in the browser.
 *
 * Throws when the project list cannot be loaded, rather than reporting "no
 * match" and sending the user into a browser hand-off they don't need.
 */
export async function findMatchingProject(input: {
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  gitUrl: string;
}): Promise<ProjectMatch | undefined> {
  const listResponse = await input.client.projects.listProjects({
    headers: input.headers,
  });
  const projects: MatchedProject[] = listResponse.data ?? [];
  if (listResponse.error !== undefined) {
    throw new ConfigurationError(
      listProjectsFailedMessage(listResponse.response.status),
    );
  }

  const matches = projects
    .filter((project) => isSameGitRepo(project.gitUrl, input.gitUrl))
    .sort(compareOldestFirst);
  const [project] = matches;
  if (project === undefined) {
    return undefined;
  }
  return { project, matchCount: matches.length };
}

function listProjectsFailedMessage(status: number): string {
  const hint =
    status === 401
      ? " Your session may have expired; run 'boboddy auth login' and try again."
      : "";
  return `Could not load your projects from the Boboddy server (HTTP ${String(status)}).${hint}`;
}

function compareOldestFirst(a: MatchedProject, b: MatchedProject): number {
  const byCreatedAt = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (Number.isFinite(byCreatedAt) && byCreatedAt !== 0) {
    return byCreatedAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
