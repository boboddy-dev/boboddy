import type { createBoboddyClient } from "@boboddy/sdk";

/** The subset of a project record this lookup cares about. */
export interface MatchedProject {
  id: string;
  gitUrl: string;
}

/**
 * Look up the project (if any) whose `gitUrl` matches this repository's
 * remote. Shared by {@link localConfigSetup}'s initial check and
 * `completeProjectHandoff`'s re-check after the user finishes creating a
 * project in the browser — a single implementation of "does a project exist
 * for this remote" rather than two independent list-and-find loops.
 */
export async function findMatchingProject(input: {
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  gitUrl: string;
}): Promise<MatchedProject | undefined> {
  const listResponse = await input.client.projects.listProjects({
    headers: input.headers,
  });
  const projects: MatchedProject[] = listResponse.data ?? [];
  return projects.find((project) => project.gitUrl === input.gitUrl);
}
