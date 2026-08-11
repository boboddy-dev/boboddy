import { PostHog } from "posthog-node";
import {
  AnalyticsEvents,
  type ApiEndpointTimedProperties,
  type SignupProperties,
} from "./events";

export type ServerInitOptions = {
  key: string;
  host: string;
};

let client: PostHog | null = null;

export function init(options: ServerInitOptions): boolean {
  if (client) return true;
  if (!options.key || !options.host) return false;
  // Serverless-safe transport settings. posthog-node defaults to batching
  // (flushAt: 20, flushInterval: 10_000) which assumes a long-lived process
  // that can drain the queue in the background. In production the API runs as
  // a Vercel Node function (apps/next/app/api/[[...slugs]]/route.ts) and the
  // instance is frozen the moment the response is returned, so a batched event
  // is never sent and is discarded when the instance is recycled. Sending on
  // every capture — combined with the explicit flush() the route handler runs
  // after the response — is what actually gets events out of an invocation.
  client = new PostHog(options.key, {
    host: options.host,
    flushAt: 1,
    flushInterval: 0,
  });

  // posthog-node never throws from background delivery — it swallows transport
  // and auth failures so analytics can't take down the host process. That is
  // the right default, but with nothing listening it also means a rejected
  // batch (wrong key type, wrong host, network egress blocked) is completely
  // invisible. Surface it in the logs instead.
  client.on("error", (error: Error) => {
    console.error("[analytics] posthog delivery failed", error);
  });

  return true;
}

// Lets callers avoid re-running init side effects (logging, env reads) and lets
// tests assert that a given entrypoint actually wired analytics up.
export function isInitialized(): boolean {
  return client !== null;
}

export function captureSignup(
  userId: string,
  properties: SignupProperties,
): void {
  if (!client) return;
  client.capture({
    distinctId: userId,
    event: AnalyticsEvents.UserSignedUp,
    properties,
  });
}

export function capture(
  userId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!client) return;
  client.capture({ distinctId: userId, event, properties });
}

export function identify(
  userId: string,
  traits?: Record<string, unknown>,
): void {
  if (!client) return;
  client.identify({ distinctId: userId, properties: traits });
}

/**
 * Merge a prior anonymous distinct id into the real, now-known one — e.g. the
 * CLI's pre-auth machine id once a `boboddy auth login` completes. `userId` is
 * the current/real id; `previousId` is the id events were captured under
 * before it was known. A no-op when the two are already the same id.
 */
export function alias(userId: string, previousId: string): void {
  if (!client) return;
  if (userId === previousId) return;
  client.alias({ distinctId: userId, alias: previousId });
}

export function captureApiEndpointTiming(
  distinctId: string,
  properties: ApiEndpointTimedProperties,
): void {
  if (!client) return;
  client.capture({
    distinctId,
    event: AnalyticsEvents.ApiEndpointTimed,
    properties,
  });
}

export function captureException(
  error: Error,
  distinctId?: string,
  context?: Record<string, unknown>,
): void {
  if (!client) return;
  client.captureException(error, distinctId, context);
}

// Drains the in-memory queue without tearing the client down, so the same
// warm instance can keep capturing. Never rejects: analytics delivery must not
// be able to fail a request that has already produced a response.
export async function flush(): Promise<void> {
  if (!client) return;
  try {
    await client.flush();
  } catch {
    // Swallowed deliberately — see above.
  }
}

export async function shutdown(): Promise<void> {
  if (!client) return;
  await client.shutdown();
  client = null;
}
