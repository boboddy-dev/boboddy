import type { AnalyticsEventName } from "@boboddy/observability/analytics/events";
import * as analyticsServer from "@boboddy/observability/analytics/server";
import {
  getOrCreateAnonymousId,
  isTelemetryDisabled,
  loadAuthProfile,
} from "@boboddy/worker";
import { createCliLogger } from "./logger";

/**
 * CLI-side reporting of the 8-milestone onboarding funnel (#147),
 * direct-to-PostHog rather than server-proxied — several milestones (init
 * started, requirements verified) happen before any authenticated session
 * exists, and routing through `apps/api` would lose exactly the pre-auth
 * drop-off signal that matters most.
 *
 * Identity: every event is keyed to a persisted anonymous id
 * (`getOrCreateAnonymousId`, `~/.boboddy.json`) until the real `userId` is
 * known, at which point later events in THIS process switch to it and a
 * PostHog `alias` call merges the two distinct ids server-side. A `userId`
 * already on disk (a signed-in session from an earlier run) is adopted the
 * same way via {@link syncIdentityFromDisk} — a login is not required for
 * every command to know who it's talking to, only for the FIRST one to.
 *
 * Never sends `accessToken`, `email`, or `name` as an event property —
 * `email`/`name` go out only as `identify()` traits, in
 * {@link identifyAuthenticatedUser}.
 *
 * Every entry point below is fire-and-forget and never throws: a telemetry
 * failure must not delay or break the command it's attached to. The one
 * bounded wait is {@link flushTelemetry}, called once near process exit —
 * see `apps/cli/src/index.ts` — so a short-lived CLI process doesn't exit
 * out from under posthog-node's in-flight delivery.
 */

/** The CLI's write-only PostHog project token. Unset ⇒ every call below is a no-op. */
export const POSTHOG_KEY_ENV_VAR = "POSTHOG_CLI_KEY";
/** Defaults to the same ingestion host every other PostHog integration in this repo uses. */
export const POSTHOG_HOST_ENV_VAR = "POSTHOG_CLI_HOST";
/** Set to `1` to opt out for a single invocation without touching `~/.boboddy.json`. */
export const TELEMETRY_DISABLED_ENV_VAR = "BOBODDY_TELEMETRY_DISABLED";
/** Set to `1` to print every telemetry payload to stderr, in addition to sending it. */
export const TELEMETRY_DEBUG_ENV_VAR = "BOBODDY_TELEMETRY_DEBUG";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_FLUSH_TIMEOUT_MS = 1500;

const logger = createCliLogger("telemetry");

/** The real, known userId for this process, once identified — `undefined` pre-auth. */
let distinctId: string | undefined;
/** Cached so every anonymous-id-keyed capture this process reuses one id, not a fresh read each time. */
let cachedAnonymousId: string | undefined;

/** Reset all in-memory (not on-disk) state. Test-only. */
export function resetTelemetryStateForTests(): void {
  distinctId = undefined;
  cachedAnonymousId = undefined;
}

function envDisabled(): boolean {
  return process.env[TELEMETRY_DISABLED_ENV_VAR] === "1";
}

function isDebug(): boolean {
  return process.env[TELEMETRY_DEBUG_ENV_VAR] === "1";
}

/** Whether telemetry is enabled at all — env var and persisted opt-out both checked. */
export function isTelemetryEnabled(): boolean {
  return !envDisabled() && !isTelemetryDisabled();
}

function ensureInitialized(): boolean {
  if (!isTelemetryEnabled()) return false;
  const key = process.env[POSTHOG_KEY_ENV_VAR] ?? "";
  const host = process.env[POSTHOG_HOST_ENV_VAR] ?? DEFAULT_POSTHOG_HOST;
  return analyticsServer.init({ key, host });
}

function resolveDistinctId(): string {
  if (distinctId) return distinctId;
  cachedAnonymousId ??= getOrCreateAnonymousId();
  return cachedAnonymousId;
}

function debugPrint(payload: Record<string, unknown>): void {
  if (!isDebug()) return;
  // Deliberately console.error, not the pino logger: the pretty-stderr
  // stream is silenced unless --verbose, but a debug env var should always
  // be visible regardless of that flag.
  console.error("[boboddy telemetry]", JSON.stringify(payload));
}

/**
 * Fire one milestone event, fire-and-forget. Never throws, never awaits the
 * network — posthog-node's own `capture` only enqueues, so this can't delay
 * the caller regardless of delivery state.
 */
export function captureMilestone(
  event: AnalyticsEventName,
  properties?: Record<string, unknown>,
): void {
  const enabled = ensureInitialized();
  // Resolved only when actually sending: `resolveDistinctId` may create AND
  // PERSIST a fresh anonymous id (`getOrCreateAnonymousId` writes to
  // `~/.boboddy.json`). Someone who opted out — env var or the persisted
  // flag itself — must not get a brand-new on-disk identifier as a side
  // effect of a command that is supposed to be a no-op.
  if (!enabled) {
    debugPrint({ event, properties, sent: false });
    return;
  }
  const id = resolveDistinctId();

  debugPrint({ event, distinctId: id, properties, sent: true });

  try {
    analyticsServer.capture(id, event, properties);
  } catch (error) {
    logger.debug({ err: error }, "telemetry capture failed");
  }
}

/**
 * Switch every later event in this process to `userId`, and — if any event
 * already went out under the anonymous id this session — merge the two via
 * PostHog `alias` so the pre-auth part of the funnel still counts toward
 * this user.
 *
 * `email`/`name` are sent ONLY as `identify()` traits here, never as an
 * event property on `captureMilestone` calls.
 */
export function identifyAuthenticatedUser(input: {
  userId: string;
  email?: string;
  name?: string;
}): void {
  const previousId = distinctId ?? cachedAnonymousId;
  distinctId = input.userId;

  if (!ensureInitialized()) return;

  analyticsServer.identify(input.userId, {
    email: input.email,
    name: input.name,
  });
  if (previousId && previousId !== input.userId) {
    analyticsServer.alias(input.userId, previousId);
  }
}

/**
 * Adopt a `userId` already on disk for `baseUrl` (a signed-in session from
 * an earlier run), so a command that never itself runs a login still
 * attributes its events to the real user instead of a fresh anonymous id.
 * A no-op once an identity has already been resolved this process — the
 * first command to know who it's talking to wins.
 */
export function syncIdentityFromDisk(baseUrl: string): void {
  if (distinctId) return;
  const profile = loadAuthProfile(baseUrl);
  if (!profile?.userId) return;
  identifyAuthenticatedUser({
    userId: profile.userId,
    email: profile.email,
    name: profile.name,
  });
}

/**
 * Drain the in-flight PostHog queue before the process exits, bounded by
 * `timeoutMs` so a slow/unreachable network never delays a command's exit
 * for more than that — called once, near the very end of `run()` in
 * `apps/cli/src/index.ts`.
 */
export async function flushTelemetry(
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (!analyticsServer.isInitialized()) return;
  await Promise.race([
    analyticsServer.flush(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
