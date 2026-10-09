import posthog from "posthog-js";
import {
  buildBootstrapCookieDeletion,
  hasPosthogCookie,
  readBootstrapCookie,
} from "./bootstrap-cookie";

export type BrowserInitOptions = {
  key: string;
  host: string;
  uiHost?: string;
};

let initialized = false;

/**
 * The share-link visitor id for this page load, or null when there is none or
 * PostHog already has an identity for this browser (a bootstrap id would
 * overwrite it). `present` tells the caller whether the handoff cookie exists
 * and so needs deleting.
 */
function readHandoff(key: string): {
  present: boolean;
  distinctId: string | null;
} {
  if (typeof document === "undefined") {
    return { present: false, distinctId: null };
  }
  const { present, distinctId } = readBootstrapCookie(document.cookie);
  return {
    present,
    distinctId: hasPosthogCookie(document.cookie, key) ? null : distinctId,
  };
}

export function init(options: BrowserInitOptions): boolean {
  if (initialized) return true;
  if (typeof window === "undefined") return false;
  if (!options.key || !options.host) return false;
  const handoff = readHandoff(options.key);
  posthog.init(options.key, {
    api_host: options.host,
    ui_host: options.uiHost,
    // Disabled because PageViewTracker captures $pageview manually on route changes.
    capture_pageview: false,
    capture_exceptions: true,
    persistence: "localStorage+cookie",
    ...(handoff.distinctId
      ? { bootstrap: { distinctID: handoff.distinctId, isIdentifiedID: false } }
      : {}),
  });
  if (handoff.present) {
    document.cookie = buildBootstrapCookieDeletion(window.location);
  }
  initialized = true;
  return true;
}

function isReady(): boolean {
  return initialized && typeof window !== "undefined";
}

export function capture(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!isReady()) return;
  posthog.capture(event, properties);
}

export function pageView(url: string): void {
  if (!isReady()) return;
  posthog.capture("$pageview", { $current_url: url });
}

export function identify(
  userId: string,
  traits?: Record<string, unknown>,
): void {
  if (!isReady()) return;
  posthog.identify(userId, traits);
}

export function reset(): void {
  if (!isReady()) return;
  posthog.reset();
}

export function captureException(
  error: Error,
  context?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  posthog.captureException(error, context);
}
