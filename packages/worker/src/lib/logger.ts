import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

export const noopLogger: Logger = pino({ level: "silent" });

/**
 * Process-wide default pino destination for loggers created without an explicit
 * `dest`. The CLI sets this once at startup (see `setDefaultLogDestination`) so
 * that *all* worker loggers — including module-level singletons — share a
 * single transport (e.g. pretty-printed to stderr) instead of writing raw
 * NDJSON to stdout where it would clobber the reporter UI.
 *
 * Left `undefined`, pino's own default (NDJSON to stdout) applies, which is the
 * correct behavior for non-interactive/piped use.
 */
let defaultLogDestination: DestinationStream | undefined;

/**
 * Set the shared default destination for loggers built via {@link createLogger}
 * and {@link createLazyLogger} without an explicit `dest`. Call this once,
 * early, before logging starts. Returns the previous destination so callers can
 * restore it if needed (useful in tests).
 */
export function setDefaultLogDestination(
  dest: DestinationStream | undefined,
): DestinationStream | undefined {
  const previous = defaultLogDestination;
  defaultLogDestination = dest;
  return previous;
}

export function createLogger(
  options: { name: string; level?: string },
  dest?: DestinationStream,
): Logger {
  return pino(
    { name: options.name, level: options.level ?? "info" },
    dest ?? defaultLogDestination,
  );
}

/**
 * Build a logger lazily on first use rather than at module-import time.
 *
 * Module-level singletons that construct a logger eagerly capture both the
 * default destination and `BOBODDY_LOG_LEVEL` at *import* time — which is
 * typically before the CLI has had a chance to configure them. Deferring
 * construction until the first log call ensures the shared destination and the
 * effective level are both in place.
 *
 * The returned proxy resolves `name`/`level` at construction time and is cached
 * thereafter.
 */
export function createLazyLogger(options: {
  name: string;
  scope?: string;
  level?: () => string | undefined;
}): Logger {
  let instance: Logger | undefined;
  const resolve = (): Logger => {
    if (!instance) {
      const base = createLogger({
        name: options.name,
        level: options.level?.() ?? process.env["BOBODDY_LOG_LEVEL"] ?? "info",
      });
      instance = options.scope ? base.child({ scope: options.scope }) : base;
    }
    return instance;
  };

  // A minimal lazy proxy. We only need the logging methods and `child`/`level`
  // used across the worker; everything else forwards to the resolved instance.
  return new Proxy({} as Logger, {
    get(_target, property, receiver) {
      const logger = resolve();
      const value: unknown = Reflect.get(logger, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(logger) : value;
    },
    set(_target, property, value) {
      const logger = resolve();
      return Reflect.set(logger, property, value);
    },
  });
}
