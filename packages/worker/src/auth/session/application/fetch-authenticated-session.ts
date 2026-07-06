import { createCliAuthClient } from "../infra/auth-client";

export async function fetchAuthenticatedSession({
  baseUrl,
  accessToken,
}: {
  baseUrl: string;
  accessToken: string;
}) {
  const authClient = createCliAuthClient({
    baseUrl,
    accessToken,
  });
  const result = await authClient.getSession();

  if (result.error || !result.data) {
    throw new Error(
      (result.error?.message ?? "Authentication required.") +
        " Run `boboddy auth login` to authenticate.",
    );
  }

  return result.data;
}
