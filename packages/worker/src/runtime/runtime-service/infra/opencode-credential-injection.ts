import {
  logWork,
  logWorkWarn,
} from "../../../work/task/application/work-logger";
import type { OpencodeCredential } from "./opencode-credential-source";
import { basicAuthHeader } from "./opencode-server-contract";

/**
 * Inject the user's provider credentials into a freshly started OpenCode 2.x
 * server over its API.
 *
 * The integration catalog loads lazily after boot: `POST /api/credential` for
 * an integration the server has not listed yet fails, so each credential waits
 * (bounded) for `GET /api/integration/{id}` to return 200 first. An integration
 * that never appears — e.g. a provider this OpenCode version does not know — is
 * warned about and skipped; it never fails the launch.
 *
 * Only integration ids and HTTP statuses are logged. Request and response
 * bodies carry secrets (the API echoes credentials back) and are never read
 * into a log or error.
 */

const INTEGRATION_WAIT_MS = 15_000;
const INTEGRATION_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;

export type InjectOpencodeCredentialsInput = {
  baseUrl: string;
  password: string;
  credentials: readonly OpencodeCredential[];
  logContext?: Record<string, unknown> | undefined;
  fetchFn?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  integrationWaitMs?: number | undefined;
};

export type InjectOpencodeCredentialsResult = {
  injected: string[];
  skipped: string[];
};

export async function injectOpencodeCredentials(
  input: InjectOpencodeCredentialsInput,
): Promise<InjectOpencodeCredentialsResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const sleep =
    input.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const now = input.now ?? Date.now;
  const context = input.logContext ?? {};
  const headers = {
    authorization: basicAuthHeader(input.password),
    accept: "application/json",
  };
  const deadline = now() + (input.integrationWaitMs ?? INTEGRATION_WAIT_MS);

  const statusOf = async (
    url: string,
    body?: string,
  ): Promise<number | string> => {
    try {
      const response = await fetchFn(url, {
        ...(body === undefined
          ? { headers }
          : {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body,
            }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.status;
    } catch (error) {
      return error instanceof Error ? error.name : "request failed";
    }
  };

  const waitForIntegration = async (
    integrationID: string,
  ): Promise<number | string> => {
    const url = `${input.baseUrl}/api/integration/${encodeURIComponent(integrationID)}`;
    for (;;) {
      const status = await statusOf(url);
      if (status === 200 || now() >= deadline) {
        return status;
      }
      await sleep(INTEGRATION_POLL_MS);
    }
  };

  const result: InjectOpencodeCredentialsResult = { injected: [], skipped: [] };
  for (const credential of input.credentials) {
    const { integrationID } = credential;
    const integrationStatus = await waitForIntegration(integrationID);
    if (integrationStatus !== 200) {
      logWorkWarn(
        "runtime",
        "OpenCode integration unavailable; credential skipped",
        {
          ...context,
          integrationID,
          status: integrationStatus,
        },
      );
      result.skipped.push(integrationID);
      continue;
    }
    const postStatus = await statusOf(
      `${input.baseUrl}/api/credential`,
      JSON.stringify({ integrationID, value: credential.value }),
    );
    if (postStatus === 200 || postStatus === 204) {
      result.injected.push(integrationID);
    } else {
      logWorkWarn("runtime", "OpenCode credential injection failed", {
        ...context,
        integrationID,
        status: postStatus,
      });
      result.skipped.push(integrationID);
    }
  }

  logWork("runtime", "OpenCode credentials injected", {
    ...context,
    injected: result.injected,
    skipped: result.skipped,
  });
  return result;
}
