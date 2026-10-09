import { loadAuthenticatedSession } from "@boboddy/worker";
import { CliError } from "./cli-error";
import { performDeviceLogin } from "./device-login";
import type { Logger } from "./logger";
import type { BaseReporter } from "./reporter-types";

/**
 * The self-healing sign-in check shared by `boboddy init` and
 * `boboddy pipelines design`.
 *
 * A stored token that the server no longer accepts (expired, revoked) counts
 * as signed out, the same as having no token at all. Either way an
 * interactive terminal heals by running the device login inline; a
 * non-interactive one stops with a {@link CliError} naming the fix, since the
 * device flow needs someone to approve it in a browser.
 */

export interface SignInPorts {
  /** Current authenticated session for `baseUrl`, or `null` when signed out. May throw on an unusable token. */
  loadSession(baseUrl: string): Promise<{ email: string } | null>;
  /** Run the interactive device-code login, reporting its own progress. Resolves once signed in. */
  login(baseUrl: string): Promise<{ email: string }>;
}

export function notSignedInMessage(baseUrl: string): string {
  return (
    `Not signed in to ${baseUrl}. Run 'boboddy auth login' in an interactive ` +
    "terminal, then re-run this command."
  );
}

/** The real {@link SignInPorts}: the stored session on disk and the device flow. */
export function createSignInPorts(input: {
  reporter: BaseReporter;
  logger: Logger;
}): SignInPorts {
  return {
    loadSession: async (baseUrl) => {
      const authenticated = await loadAuthenticatedSession(baseUrl);
      return authenticated ? { email: authenticated.session.user.email } : null;
    },
    login: (baseUrl) =>
      performDeviceLogin({
        baseUrl,
        reporter: input.reporter,
        logger: input.logger,
      }),
  };
}

export async function ensureSignedIn(input: {
  baseUrl: string;
  interactive: boolean;
  reporter: BaseReporter;
  ports: SignInPorts;
}): Promise<{ email: string }> {
  const { baseUrl, interactive, reporter, ports } = input;

  const existing = await loadSessionOrNull(ports, baseUrl);
  if (existing) {
    reporter.success(`Signed in as ${existing.email}`);
    return existing;
  }

  if (!interactive) {
    throw new CliError(
      "not_signed_in_noninteractive",
      notSignedInMessage(baseUrl),
    );
  }

  reporter.info(`Not signed in to ${baseUrl}. Starting sign-in…`);
  return ports.login(baseUrl);
}

async function loadSessionOrNull(
  ports: SignInPorts,
  baseUrl: string,
): Promise<{ email: string } | null> {
  try {
    return await ports.loadSession(baseUrl);
  } catch {
    return null;
  }
}
