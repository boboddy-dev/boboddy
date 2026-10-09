import { CLI_AUTH_CLIENT_ID } from "../infra/auth-config";
import { createCliAuthClient } from "../infra/auth-client";
import { CoreError, SetupErrorCodes } from "../../../lib/errors";

type DeviceLoginErrorCode =
  | typeof SetupErrorCodes.DeviceLoginExpired
  | typeof SetupErrorCodes.DeviceLoginDenied
  | typeof SetupErrorCodes.DeviceLoginFailed;

/** Why the device-authorization flow ended without a token. */
export class DeviceLoginError extends CoreError {
  constructor(message: string, code: DeviceLoginErrorCode) {
    super({ code, message, status: 401 });
  }
}

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export async function pollForAccessToken({
  baseUrl,
  deviceCode,
  intervalSeconds,
  expiresInSeconds,
}: {
  baseUrl: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}) {
  const authClient = createCliAuthClient({ baseUrl });
  const deadline = Date.now() + expiresInSeconds * 1000;
  let currentIntervalSeconds = intervalSeconds;

  while (Date.now() < deadline) {
    await sleep(currentIntervalSeconds * 1000);

    const result = await authClient.device.token({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: CLI_AUTH_CLIENT_ID,
    });

    if (result.data?.access_token) {
      return result.data;
    }

    const errorCode = result.error?.error ?? "";
    switch (errorCode) {
      case "authorization_pending":
        continue;
      case "slow_down":
        currentIntervalSeconds += 5;
        continue;
      case "expired_token":
        throw new DeviceLoginError(
          "The CLI sign-in request expired. Run `boboddy auth login` again.",
          SetupErrorCodes.DeviceLoginExpired,
        );
      case "access_denied":
        throw new DeviceLoginError(
          "CLI access was denied.",
          SetupErrorCodes.DeviceLoginDenied,
        );
      default:
        throw new DeviceLoginError(
          result.error?.error_description ??
            "CLI sign-in could not be completed.",
          SetupErrorCodes.DeviceLoginFailed,
        );
    }
  }

  throw new DeviceLoginError(
    "Timed out waiting for CLI approval.",
    SetupErrorCodes.DeviceLoginExpired,
  );
}
