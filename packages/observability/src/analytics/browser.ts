import posthog from "posthog-js";

export type BrowserInitOptions = {
  key: string;
  host: string;
  uiHost?: string;
};

let initialized = false;

export function init(options: BrowserInitOptions): boolean {
  if (initialized) return true;
  if (typeof window === "undefined") return false;
  if (!options.key || !options.host) return false;
  posthog.init(options.key, {
    api_host: options.host,
    ui_host: options.uiHost,
    // Disabled because PageViewTracker captures $pageview manually on route changes.
    capture_pageview: false,
    capture_exceptions: true,
    persistence: "localStorage+cookie",
  });
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
