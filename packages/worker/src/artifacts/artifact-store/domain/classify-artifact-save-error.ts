const MAX_ERROR_MESSAGE_LENGTH = 1000;

export type ClassifiedArtifactSaveError = {
  errorCode: string;
  errorMessage: string;
  httpStatus: number | null;
};

/**
 * Turns whatever {@link ArtifactStore.saveArtifact} throws into a stable,
 * DB-safe shape.
 *
 * The main case this exists for is `RemoteArtifactStore.saveArtifact`
 * (`../infra/remote-artifact-store.ts`), which delegates to
 * `createStepExecutionPlaneClient` (`@boboddy/sdk`'s
 * `step-execution-plane-client.ts`). That client's control-plane calls do
 * `if (result.error) throw new Error(JSON.stringify(result.error))` — so the
 * only signal available is a JSON string sitting in `Error#message`. The
 * generated `result.error` for these endpoints is an RFC 7807-flavored
 * problem-details object: `{ type, title, status, detail?, instance?, code?,
 * errors? }` (see `PostApiStepExecutionsByStepExecutionIdArtifactUploadUrlErrors`
 * in `@boboddy/sdk`'s generated `types.gen.ts`) — there is no nested `error`
 * key.
 *
 * The API's `createProblemDetails` (`apps/api/src/problem-details.ts`) always
 * fills `code` — either from a thrown `CoreError`'s own `code` (e.g.
 * `UsageLimitExceededError`'s `USAGE_LIMIT_EXCEEDED_STORAGE`) or, failing
 * that, from Elysia's own error code/status as a fallback string — so in
 * practice `parsed.code` is present whenever `parsed` really is one of these
 * problem-details bodies. This function still treats `code` as optional and
 * derives a generic `"UPLOAD_HTTP_ERROR"` (or `"UNKNOWN"`) fallback from
 * `status` alone, rather than guessing at specific business codes, since
 * hardcoding e.g. "402 always means storage" here would silently drift from
 * whatever the API actually decides to throw for a given status.
 *
 * This function must never throw itself: any shape that isn't the expected
 * problem-details JSON (a plain network failure, a timeout, a non-`Error`
 * throw, malformed JSON, etc.) falls through to `errorCode: "UNKNOWN"` with a
 * best-effort message and a `null` http status, so callers can always safely
 * persist the result.
 */
export function classifyArtifactSaveError(
  // Parses whatever `ArtifactStore.saveArtifact` throws at the boundary;
  // there is no narrower input type to declare for `error` here.
  // eslint-disable-next-line local/no-unknown-parameter-type
  error: unknown,
): ClassifiedArtifactSaveError {
  const fallback: ClassifiedArtifactSaveError = {
    errorCode: "UNKNOWN",
    errorMessage: capMessage(bestEffortMessage(error)),
    httpStatus: null,
  };

  if (!(error instanceof Error)) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(error.message);
    if (!isRecord(parsed)) {
      return fallback;
    }

    const status = parsed["status"];
    const code = parsed["code"];
    const detail = parsed["detail"];
    const title = parsed["title"];

    const httpStatus = typeof status === "number" ? status : null;
    const errorCode =
      typeof code === "string" && code.length > 0
        ? code
        : httpStatus !== null
          ? "UPLOAD_HTTP_ERROR"
          : "UNKNOWN";

    const errorMessage =
      (typeof detail === "string" && detail) ||
      (typeof title === "string" && title) ||
      fallback.errorMessage;

    return {
      errorCode,
      errorMessage: capMessage(errorMessage),
      httpStatus,
    };
  } catch {
    return fallback;
  }
}

// Narrows the `JSON.parse` result above at the boundary; there is no
// narrower input type to declare for `value` here.
// eslint-disable-next-line local/no-unknown-parameter-type
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Builds a best-effort fallback message from whatever was thrown; there is
// no narrower input type to declare for `error` here.
// eslint-disable-next-line local/no-unknown-parameter-type
function bestEffortMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.message || String(error);
    }
    return String(error);
  } catch {
    return "Unknown artifact save error";
  }
}

function capMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
    : message;
}
