import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/**
 * Secret-bearing request fields (`POST /me/secrets` `value`, pasted Jira
 * `apiKey`, pasted GitHub `token`, pasted Bitbucket `apiToken`) are censored
 * if a request body is ever logged.
 */
export const REDACTED_LOG_PATHS = [
  "body.value",
  "body.apiKey",
  "body.token",
  "body.apiToken",
  "body.credential.apiKey",
  "body.credential.token",
  "body.credential.apiToken",
  "body.issueTracker.credential.apiKey",
  "body.issueTracker.credential.token",
  "body.issueTracker.credential.apiToken",
  "*.body.value",
  "*.body.apiKey",
  "*.body.token",
  "*.body.apiToken",
  "*.body.credential.apiKey",
  "*.body.credential.token",
  "*.body.credential.apiToken",
  "*.body.issueTracker.credential.apiKey",
  "*.body.issueTracker.credential.token",
  "*.body.issueTracker.credential.apiToken",
  "apiKey",
  "*.apiKey",
  "token",
  "*.token",
  "apiToken",
  "*.apiToken",
];

export function createLogger(
  options: { name: string; level?: string },
  dest?: DestinationStream,
): Logger {
  return pino(
    {
      name: options.name,
      level: options.level ?? "info",
      redact: { paths: REDACTED_LOG_PATHS, censor: "[REDACTED]" },
    },
    dest,
  );
}

export const noopLogger: Logger = pino({ level: "silent" });
