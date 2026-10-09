import { createBoboddyClient } from "@boboddy/sdk";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import { ConfigurationError, SetupErrorCodes } from "../../../lib/errors";
import {
  findGitRoot,
  NOT_IN_GIT_REPOSITORY_MESSAGE,
} from "./resolve-git-repository";

export async function verifyRequirements(input: { baseUrl: string }): Promise<{
  headers: { Authorization: string };
  client: ReturnType<typeof createBoboddyClient>;
}> {
  let session: Awaited<ReturnType<typeof loadAuthenticatedSession>>;
  try {
    session = await loadAuthenticatedSession(input.baseUrl);
  } catch {
    session = null;
  }
  if (!session) {
    throw new ConfigurationError(
      `Not signed in to ${input.baseUrl}. Run 'boboddy auth login' in an ` +
        "interactive terminal, then re-run this command.",
      SetupErrorCodes.NotSignedIn,
    );
  }

  // Walk-up (submodule-safe), not a literal check on `process.cwd()` — a
  // subdirectory of the repo is a valid place to run `init` from. Callers
  // that already resolved the repo (see `resolveGitRepository`) pay for a
  // second, cheap walk here; this check exists so `verifyRequirements` stays
  // safe to call on its own.
  if (!(await findGitRoot(process.cwd()))) {
    throw new ConfigurationError(
      NOT_IN_GIT_REPOSITORY_MESSAGE,
      SetupErrorCodes.NotInGitRepository,
    );
  }

  return {
    headers: { Authorization: `Bearer ${session.profile.accessToken}` },
    client: createBoboddyClient(input.baseUrl),
  };
}
