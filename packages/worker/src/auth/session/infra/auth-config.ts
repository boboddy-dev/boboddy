const DEFAULT_BASE_URL = "https://app.boboddy.dev";

export const CLI_AUTH_CLIENT_ID = "boboddy-cli";

const trimTrailingSlashes = (value: string) => {
  let endIndex = value.length;
  while (endIndex > 0 && value.charAt(endIndex - 1) === "/") {
    endIndex -= 1;
  }
  return value.slice(0, endIndex);
};

export const resolveBoboddyBaseUrl = (value?: string | null) => {
  const trimmedValue = value?.trim();
  if (trimmedValue) {
    return trimTrailingSlashes(trimmedValue);
  }

  const envValue = process.env["BOBODDY_BASE_URL"]?.trim();
  if (envValue) {
    return trimTrailingSlashes(envValue);
  }

  return DEFAULT_BASE_URL;
};
