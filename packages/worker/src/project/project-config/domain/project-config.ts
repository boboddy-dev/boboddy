import { formatProjectRef } from "@boboddy/sdk/defaults";
import { ConfigurationError, SetupErrorCodes } from "../../../lib/errors";

export type { ProjectConfig } from "@boboddy/sdk/defaults";

/**
 * The `owner/slug` ref `.boboddy/boboddy.jsonc` stores for a project. Throws
 * when the owner has no username yet: there is no ref to write until they
 * finish username onboarding.
 */
export function projectConfigRef(project: {
  name: string;
  slug: string;
  ownerUsername: string | null;
}): string {
  if (!project.ownerUsername) {
    throw new ConfigurationError(
      `Project "${project.name}" has no owner username yet, so it can't be written to .boboddy/boboddy.jsonc. ` +
        "Finish choosing a username in the Boboddy web app, then run `boboddy init` again.",
      SetupErrorCodes.NoOwnerUsername,
    );
  }
  return formatProjectRef({ owner: project.ownerUsername, slug: project.slug });
}
