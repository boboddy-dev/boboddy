import { randomBytes } from "node:crypto";

/**
 * The OpenCode v2 `serve` contract Boboddy depends on, in one place: how a
 * server is authenticated, how its readiness is probed, and the log flags it is
 * launched with. Shared by the host and devcontainer bootstraps and the dry-run
 * health re-check.
 *
 * Readiness on v2: `GET /api/info` answers `401` without credentials and
 * `200 {"version": …}` with basic auth. Other paths (e.g. `/global/health`)
 * serve the web shell as `200 text/html` regardless of state, so a bare
 * `response.ok` says nothing about the API being up.
 */

export const READINESS_PATH = "/api/info";

/** Basic-auth username `opencode serve` expects alongside `OPENCODE_SERVER_PASSWORD`. */
export const SERVER_USERNAME = "opencode";

/** Env var `opencode serve` reads its basic-auth password from. */
export const SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";

/**
 * Mirror OpenCode's structured `key=value` log lines to stderr so the serve-log
 * redirect captures them. The level value is lowercase-only.
 */
export const SERVE_LOG_ARGS: readonly string[] = [
  "--print-logs",
  "--log-level",
  "info",
];

const SERVER_PASSWORD_BYTES = 32;
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_READINESS_INTERVAL_MS = 500;

/** Everything a client needs to talk to one running OpenCode server. */
export type OpencodeServerHandle = {
  baseUrl: string;
  password: string;
  /** Directory the server's sessions operate against. */
  workspaceFolder: string;
};

export function toOpencodeServerHandle(
  agent: { baseUrl: string; password: string },
  workspaceFolder: string,
): OpencodeServerHandle {
  return { baseUrl: agent.baseUrl, password: agent.password, workspaceFolder };
}

export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString("base64")}`;
}

/** A fresh per-session server password: 32 crypto-random bytes, base64url. */
export function generateServerPassword(): string {
  return randomBytes(SERVER_PASSWORD_BYTES).toString("base64url");
}

export type ReadinessProbeResult =
  | { kind: "ready"; version: string }
  | { kind: "not-yet"; reason: string }
  | { kind: "wrong-version"; version: string };

export type ProbeReadinessInput = {
  baseUrl: string;
  password: string;
  expectedVersion: string;
  signal?: AbortSignal | undefined;
};

/**
 * One readiness probe. Ready only on `200` with a JSON body whose `version`
 * equals `expectedVersion`; a different version means the wrong binary is
 * serving. Anything else (refused connection, `401`, an HTML page, a body
 * without a version) is "not yet".
 */
export async function probeReadiness(
  input: ProbeReadinessInput,
): Promise<ReadinessProbeResult> {
  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}${READINESS_PATH}`, {
      headers: {
        authorization: basicAuthHeader(input.password),
        accept: "application/json",
      },
      signal: input.signal,
    });
  } catch (error) {
    return {
      kind: "not-yet",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return {
      kind: "not-yet",
      reason: `failed to read body: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status !== 200) {
    return { kind: "not-yet", reason: `HTTP ${String(response.status)}` };
  }

  const version = readVersion(text);
  if (version === null) {
    return {
      kind: "not-yet",
      reason: "HTTP 200 without a JSON body carrying a version",
    };
  }
  if (version !== input.expectedVersion) {
    return { kind: "wrong-version", version };
  }
  return { kind: "ready", version };
}

function readVersion(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : null;
}

export type WaitForReadinessResult =
  | { kind: "ready"; attempts: number }
  | { kind: "timeout"; attempts: number; lastReason: string | null }
  | { kind: "wrong-version"; attempts: number; version: string };

function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll {@link probeReadiness} until the server is ready, reports the wrong
 * version, or `timeoutMs` elapses. `assertAlive` runs before every attempt and
 * after every failed one; it throws to abort the wait (e.g. the process died).
 * Aborting `signal` cuts short the in-flight probe or the pause between
 * probes, then runs `assertAlive` and throws the signal's reason if it didn't.
 */
export async function waitForReadiness(input: {
  baseUrl: string;
  password: string;
  expectedVersion: string;
  timeoutMs?: number | undefined;
  intervalMs?: number | undefined;
  assertAlive?: (() => Promise<void>) | undefined;
  onNotReady?: ((attempt: number, reason: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<WaitForReadinessResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const { signal } = input;
  let attempts = 0;
  let lastReason: string | null = null;

  while (Date.now() < deadline) {
    await input.assertAlive?.();
    signal?.throwIfAborted();
    attempts += 1;
    const probeTimeout = AbortSignal.timeout(intervalMs);
    const result = await probeReadiness({
      baseUrl: input.baseUrl,
      password: input.password,
      expectedVersion: input.expectedVersion,
      signal: signal ? AbortSignal.any([signal, probeTimeout]) : probeTimeout,
    });
    if (result.kind === "ready") {
      return { kind: "ready", attempts };
    }
    if (result.kind === "wrong-version") {
      return { kind: "wrong-version", attempts, version: result.version };
    }
    lastReason = result.reason;

    await input.assertAlive?.();
    signal?.throwIfAborted();
    input.onNotReady?.(attempts, result.reason);
    await sleepUnlessAborted(intervalMs, signal);
  }

  return { kind: "timeout", attempts, lastReason };
}
