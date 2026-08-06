import {
  CLI_AUTH_CLIENT_ID,
  persistAuthenticatedSession,
  pollForAccessToken,
  requestDeviceAuthorization,
} from "@boboddy/worker";
import { openBrowser } from "../auth/browser";
import type { Logger } from "./logger";
import type { BaseReporter } from "./reporter-types";

/**
 * The OAuth device-authorization flow, factored out of `boboddy auth login` so
 * other commands can heal a missing session inline instead of telling the user
 * to go and run `auth login` themselves.
 *
 * It deliberately takes the reporter and logger rather than opening its own
 * `withReporter` scope: nesting reporters would render two intro banners and
 * two live spinners into the same terminal.
 */

export type PerformDeviceLoginInput = {
  baseUrl: string;
  reporter: BaseReporter;
  logger: Logger;
};

export type PerformDeviceLoginResult = {
  /** Email of the signed-in user. Safe to display; never a token. */
  email: string;
};

export async function performDeviceLogin(
  input: PerformDeviceLoginInput,
): Promise<PerformDeviceLoginResult> {
  const { baseUrl, reporter, logger } = input;
  const deviceAuth = await requestDeviceAuthorization(baseUrl);

  const verificationUri =
    deviceAuth.verification_uri_complete || deviceAuth.verification_uri;

  reporter.info("Open this URL to approve the CLI");
  reporter.info(`URL: ${verificationUri}`);
  reporter.info(`Code: ${deviceAuth.user_code}`);

  logger.info(
    {
      url: verificationUri,
      code: deviceAuth.user_code,
      clientId: CLI_AUTH_CLIENT_ID,
    },
    "Approval details",
  );

  try {
    await openBrowser(verificationUri);
  } catch {
    reporter.warn(
      "Could not open a browser automatically. Open the URL above manually.",
    );
  }

  const task = reporter.startTask("Waiting for approval…");

  let tokenResponse;
  try {
    tokenResponse = await pollForAccessToken({
      baseUrl,
      deviceCode: deviceAuth.device_code,
      intervalSeconds: deviceAuth.interval,
      expiresInSeconds: deviceAuth.expires_in,
    });
  } catch (error) {
    task.fail("Approval failed");
    throw error;
  }

  const session = await persistAuthenticatedSession({
    baseUrl,
    accessToken: tokenResponse.access_token,
  });

  task.succeed(`Signed in as ${session.user.email}`);
  return { email: session.user.email };
}
