import { CLI_AUTH_CLIENT_ID } from "../infra/auth-config";
import { createCliAuthClient } from "../infra/auth-client";
import { SetupErrorCodes } from "../../../lib/errors";
import { DeviceLoginError } from "./poll-for-access-token";

export async function requestDeviceAuthorization(baseUrl: string) {
  const authClient = createCliAuthClient({ baseUrl });
  const result = await authClient.device.code({
    client_id: CLI_AUTH_CLIENT_ID,
    scope: "openid profile email",
  });

  if (!result.data) {
    throw new DeviceLoginError(
      "Unable to start CLI authentication.",
      SetupErrorCodes.DeviceLoginFailed,
    );
  }

  return result.data;
}
