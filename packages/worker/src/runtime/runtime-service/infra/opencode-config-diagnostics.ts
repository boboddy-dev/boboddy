import type { SecretMasker } from "../../../work/task/application/secret-masker";
import {
  logWork,
  logWorkWarn,
} from "../../../work/task/application/work-logger";
import { basicAuthHeader } from "./opencode-server-contract";

/**
 * Boot-time config diagnostics for an OpenCode 2.x server.
 *
 * OpenCode loads config lazily: an invalid document neither fails `serve` nor
 * `/api/info`, it is only normalised — and its problems only logged — when the
 * first location-scoped request runs. So after readiness this forces one
 * `GET /api/config?directory=<workspace>` and scans the server log for
 * `message="configuration normalization diagnostic"` lines:
 *
 * - `kind=invalid` with `source=OPENCODE_CONFIG_CONTENT` is Boboddy's own
 *   generated overlay being rejected — a Boboddy bug that silently drops part
 *   of the permission baseline or a step MCP server — so the launch fails.
 * - Everything else (the user's global config, legacy-syntax warnings) is
 *   logged at warn and otherwise left alone.
 *
 * The lines are read from the `--print-logs` serve log both bootstraps already
 * capture. It carries the same structured lines as `opencode.log`, but they land
 * there as the request runs instead of on the next file flush.
 */

export const CONFIG_DIAGNOSTIC_MESSAGE =
  'message="configuration normalization diagnostic"';
export const OVERLAY_CONFIG_SOURCE = "OPENCODE_CONFIG_CONTENT";

const SETTLE_INTERVAL_MS = 200;
const MAX_LOG_READS = 6;
const CONFIG_REQUEST_TIMEOUT_MS = 10_000;
const VOLATILE_FIELDS = new Set(["timestamp", "http.span", "run"]);

export type OpencodeConfigDiagnostic = {
  source: string;
  path: string;
  kind: string;
  action: string;
  /** The log line without its volatile fields. Not yet masked. */
  line: string;
};

const FIELD_PATTERN = /([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|\S+)/gu;

function parseFields(line: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of line.matchAll(FIELD_PATTERN)) {
    const [, key, raw] = match;
    if (key === undefined || raw === undefined) {
      continue;
    }
    fields.set(key, raw.startsWith('"') ? raw.slice(1, -1) : raw);
  }
  return fields;
}

function stripVolatileFields(line: string): string {
  return line
    .replace(FIELD_PATTERN, (whole, key: string) =>
      VOLATILE_FIELDS.has(key) ? "" : whole,
    )
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Extract the distinct configuration diagnostics from raw log text. OpenCode
 * logs each diagnostic once per config load, so the same finding repeats;
 * duplicates collapse on `source`/`path`/`kind`/`action`.
 */
export function parseOpencodeConfigDiagnostics(
  log: string,
): OpencodeConfigDiagnostic[] {
  const byKey = new Map<string, OpencodeConfigDiagnostic>();
  for (const line of log.split(/\r?\n/u)) {
    if (!line.includes(CONFIG_DIAGNOSTIC_MESSAGE)) {
      continue;
    }
    const fields = parseFields(line);
    const diagnostic: OpencodeConfigDiagnostic = {
      source: fields.get("source") ?? "",
      path: fields.get("path") ?? "",
      kind: fields.get("kind") ?? "",
      action: fields.get("action") ?? "",
      line: stripVolatileFields(line),
    };
    const key = [
      diagnostic.source,
      diagnostic.path,
      diagnostic.kind,
      diagnostic.action,
    ].join("\u0000");
    if (!byKey.has(key)) {
      byKey.set(key, diagnostic);
    }
  }
  return [...byKey.values()];
}

/** Whether a diagnostic means Boboddy's own overlay was rejected. */
export function isOverlayRejection(
  diagnostic: OpencodeConfigDiagnostic,
): boolean {
  return (
    diagnostic.kind === "invalid" && diagnostic.source === OVERLAY_CONFIG_SOURCE
  );
}

export class OpencodeOverlayConfigRejectedError extends Error {
  constructor(maskedLines: readonly string[]) {
    super(
      "OpenCode rejected part of Boboddy's generated config overlay " +
        "(OPENCODE_CONFIG_CONTENT). This is a Boboddy bug; the rejected values " +
        "would have been silently dropped:\n" +
        maskedLines.join("\n"),
    );
    this.name = "OpencodeOverlayConfigRejectedError";
  }
}

export type CheckOpencodeConfigDiagnosticsInput = {
  baseUrl: string;
  password: string;
  workspaceFolder: string;
  /** Returns the server log text (or only its diagnostic lines). */
  readLog: () => Promise<string | null>;
  masker: SecretMasker;
  /** Extra structured fields for every log line written here. */
  logContext?: Record<string, unknown> | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  fetchFn?: typeof fetch | undefined;
};

/**
 * Force config loading, collect the resulting diagnostics, warn about each, and
 * throw {@link OpencodeOverlayConfigRejectedError} if the overlay was rejected.
 */
export async function checkOpencodeConfigDiagnostics(
  input: CheckOpencodeConfigDiagnosticsInput,
): Promise<OpencodeConfigDiagnostic[]> {
  const sleep =
    input.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const context = input.logContext ?? {};

  await requestConfig(input);

  let diagnostics: OpencodeConfigDiagnostic[] = [];
  let previousKeys: string | null = null;
  for (let read = 0; read < MAX_LOG_READS; read += 1) {
    if (read > 0) {
      await sleep(SETTLE_INTERVAL_MS);
    }
    diagnostics = parseOpencodeConfigDiagnostics((await input.readLog()) ?? "");
    const keys = diagnostics.map((diagnostic) => diagnostic.line).join("\n");
    if (keys === previousKeys) {
      break;
    }
    previousKeys = keys;
  }

  const masked = (diagnostic: OpencodeConfigDiagnostic) =>
    input.masker.mask(diagnostic.line);

  for (const diagnostic of diagnostics) {
    logWorkWarn("runtime", "OpenCode configuration diagnostic", {
      ...context,
      source: input.masker.mask(diagnostic.source),
      path: diagnostic.path,
      kind: diagnostic.kind,
      action: diagnostic.action,
    });
  }

  const rejections = diagnostics.filter(isOverlayRejection);
  if (rejections.length > 0) {
    throw new OpencodeOverlayConfigRejectedError(rejections.map(masked));
  }

  logWork("runtime", "OpenCode configuration checked", {
    ...context,
    diagnosticCount: diagnostics.length,
  });
  return diagnostics;
}

async function requestConfig(
  input: CheckOpencodeConfigDiagnosticsInput,
): Promise<void> {
  const fetchFn = input.fetchFn ?? fetch;
  const url = `${input.baseUrl}/api/config?directory=${encodeURIComponent(input.workspaceFolder)}`;
  try {
    const response = await fetchFn(url, {
      headers: {
        authorization: basicAuthHeader(input.password),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(CONFIG_REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) {
      logWorkWarn("runtime", "OpenCode config request failed", {
        ...input.logContext,
        status: response.status,
      });
    }
  } catch (error) {
    logWorkWarn("runtime", "OpenCode config request failed", {
      ...input.logContext,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
