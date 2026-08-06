import { createBoboddyClient } from "@boboddy/sdk/client";
import { loadAuthenticatedSession } from "@boboddy/worker";

/**
 * The two things a CLI adapter that talks to the API needs: an authenticated
 * client, and a way to turn the server's error body into a sentence.
 *
 * Kept separate from the adapters themselves so they stay thin. Commands that
 * only need an access token — `pipelines push`, `pipelines pull`, `auth` — still
 * call `loadAuthenticatedSession` directly rather than build a client they will
 * not use.
 */

export type AuthenticatedApi = {
  client: ReturnType<typeof createBoboddyClient>;
  /**
   * Passed per call, as a sibling of `path`/`query`/`body` — the generated
   * client does not bind headers to the instance.
   */
  headers: { Authorization: string };
};

/** An authenticated client for `baseUrl`, or a throw naming the fix. */
export async function connectApi(baseUrl: string): Promise<AuthenticatedApi> {
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new Error(
      `Not signed in to ${baseUrl}. Run \`boboddy auth login\` first.`,
    );
  }
  return {
    client: createBoboddyClient(baseUrl),
    headers: { Authorization: `Bearer ${authenticated.profile.accessToken}` },
  };
}

/**
 * The API's error bodies are RFC 7807 Problem Details (see
 * `apiErrorResponseSchema`), so `detail` is the sentence written for a human and
 * `title` the short fallback. Both beat `JSON.stringify`, which puts a brace
 * salad in front of the user.
 */
export function describeApiError(error: {
  title?: string | undefined;
  detail?: string | undefined;
}): string {
  return error.detail ?? error.title ?? "the server rejected the request";
}
