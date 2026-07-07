import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  CLI_AUTH_CLIENT_ID,
  deleteAuthProfile,
  loadAuthenticatedSession,
  loadAuthProfile,
  persistAuthenticatedSession,
  pollForAccessToken,
  requestDeviceAuthorization,
  resolveBoboddyBaseUrl,
} from "@boboddy/worker";
import { withReporter } from "../lib/command-output";
import { openBrowser } from "../auth/browser";

const addBaseUrlOption = (argv: Argv<object>) =>
  argv.option("base-url", {
    type: "string",
    describe: "Boboddy app base URL",
  });

const getBaseUrlArgument = (arguments_: ArgumentsCamelCase<object>) => {
  const value = arguments_["base-url"];
  return typeof value === "string" ? value : undefined;
};

const runLogin = async (arguments_: ArgumentsCamelCase<object>) =>
  withReporter("auth", async ({ reporter, logger }) => {
    const baseUrl = resolveBoboddyBaseUrl(getBaseUrlArgument(arguments_));
    const deviceAuth = await requestDeviceAuthorization(baseUrl);

    const verificationUri =
      deviceAuth.verification_uri_complete || deviceAuth.verification_uri;

    reporter.info("Open this URL to approve the CLI");
    reporter.info(`URL: ${verificationUri}`);
    reporter.info(`Code: ${deviceAuth.user_code}`);

    logger.info(
      { url: verificationUri, code: deviceAuth.user_code, clientId: CLI_AUTH_CLIENT_ID },
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
  });

const runStatus = async (arguments_: ArgumentsCamelCase<object>) =>
  withReporter("auth", async ({ reporter }) => {
    const baseUrl = resolveBoboddyBaseUrl(getBaseUrlArgument(arguments_));
    const profile = loadAuthProfile(baseUrl);

    if (!profile) {
      reporter.info(`Not signed in to ${baseUrl}`);
      return;
    }

    try {
      const authenticated = await loadAuthenticatedSession(baseUrl);
      if (!authenticated) {
        reporter.info(`Not signed in to ${baseUrl}`);
        return;
      }

      reporter.success(
        `Signed in to ${baseUrl} as ${authenticated.session.user.email}`,
      );
    } catch {
      reporter.warn(`Stored credentials for ${baseUrl} are no longer valid`);
    }
  });

const runWhoAmI = async (arguments_: ArgumentsCamelCase<object>) =>
  withReporter("auth", async () => {
    const baseUrl = resolveBoboddyBaseUrl(getBaseUrlArgument(arguments_));
    const authenticated = await loadAuthenticatedSession(baseUrl);

    if (!authenticated) {
      throw new Error(`Not signed in to ${baseUrl}.`);
    }

    process.stdout.write(authenticated.session.user.email + "\n");
  });

const runLogout = async (arguments_: ArgumentsCamelCase<object>) =>
  withReporter("auth", ({ reporter }) => {
    const baseUrl = resolveBoboddyBaseUrl(getBaseUrlArgument(arguments_));
    deleteAuthProfile(baseUrl);
    reporter.success(`Signed out of ${baseUrl}`);
  });

const loginCommand: CommandModule<object, object> = {
  command: "login",
  describe: "Authenticate this CLI via browser approval",
  builder: addBaseUrlOption,
  handler: runLogin,
};

const statusCommand: CommandModule<object, object> = {
  command: "status",
  describe: "Show current CLI authentication status",
  builder: addBaseUrlOption,
  handler: runStatus,
};

const whoamiCommand: CommandModule<object, object> = {
  command: "whoami",
  describe: "Print the authenticated user email",
  builder: addBaseUrlOption,
  handler: runWhoAmI,
};

const logoutCommand: CommandModule<object, object> = {
  command: "logout",
  describe: "Remove stored CLI credentials",
  builder: addBaseUrlOption,
  handler: runLogout,
};

export const authCommand: CommandModule<object, object> = {
  command: "auth <command>",
  describe: "Authenticate the Boboddy CLI",
  builder: (argv) =>
    argv
      .command(loginCommand)
      .command(statusCommand)
      .command(whoamiCommand)
      .command(logoutCommand)
      .demandCommand(1, "An auth command is required."),
  handler: () => undefined,
};
