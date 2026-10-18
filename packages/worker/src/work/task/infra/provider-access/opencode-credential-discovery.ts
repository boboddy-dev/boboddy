import { noopLogger, type Logger } from "@boboddy/observability/logging/host";
import {
  loadOpencodeCredentials,
  type LoadOpencodeCredentialsInput,
  type OpencodeCredential,
} from "../../../../runtime/runtime-service/infra/opencode-credential-source";

/**
 * Whether the user has any OpenCode provider credential, and for which
 * integrations.
 *
 * Reads the same source the runtime injects from (`opencode-credential-source.ts`:
 * the pinned runtime's `auth export --standalone`, a v1 `auth.json`, and the
 * well-known provider API-key env vars), so "logged in" here means exactly
 * "something will be injected into the session's server".
 *
 * Returns integration ids ONLY — never tokens or any part of a credential value.
 */

export type ListOpencodeAuthProvidersInput = Pick<
  LoadOpencodeCredentialsInput,
  "launcherPath" | "homeDir" | "env"
> & {
  /** Receives expired-OAuth and export-failure warnings. Defaults to no-op. */
  logger?: Logger | undefined;
  /** Injected credential loader (tests). */
  loadCredentials?:
    | ((input: LoadOpencodeCredentialsInput) => Promise<OpencodeCredential[]>)
    | undefined;
};

/**
 * List the integration ids that have a usable credential, sorted. An OAuth
 * credential whose stored expiry has passed is still listed (OpenCode refreshes
 * it with the refresh token) but logged at warn.
 */
export async function listOpencodeAuthProviders(
  input: ListOpencodeAuthProvidersInput = {},
): Promise<string[]> {
  const logger = input.logger ?? noopLogger;
  const credentials = await (input.loadCredentials ?? loadOpencodeCredentials)({
    launcherPath: input.launcherPath,
    homeDir: input.homeDir,
    env: input.env,
    onWarning: (message) => {
      logger.warn({}, message);
    },
  });

  for (const { integrationID, value } of credentials) {
    if (
      value.type === "oauth" &&
      value.expires > 0 &&
      Date.now() >= value.expires
    ) {
      const expiredAt = new Date(value.expires).toISOString();
      logger.warn(
        { providerId: integrationID, expiredAt },
        `OpenCode OAuth credential for provider "${integrationID}" expired at ` +
          `${expiredAt}. OpenCode will try to refresh it; re-authenticate via ` +
          "OpenCode if the provider call fails.",
      );
    }
  }

  return [
    ...new Set(credentials.map(({ integrationID }) => integrationID)),
  ].sort((left, right) => left.localeCompare(right));
}
