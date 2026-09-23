import type { ApiErrorBody } from "./api-types";

/**
 * The API's error bodies are RFC 7807 Problem Details, so `detail` is the
 * sentence written for a human and `title` the short fallback. Reimplemented
 * locally (rather than imported from `apps/cli/src/lib/cli-api-client.ts`)
 * because `platform-client` must not depend on `apps/cli` — see
 * `apps/cli/src/lib/cli-api-client.ts`'s `describeApiError` for the
 * original.
 */
export function describeApiError(error: ApiErrorBody): string {
  return error.detail ?? error.title ?? "the server rejected the request";
}
