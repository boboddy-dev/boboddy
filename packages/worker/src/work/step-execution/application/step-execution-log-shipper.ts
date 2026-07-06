import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  StepExecutionLogLevel,
  StepExecutionLogLine,
  StepExecutionLogStream,
  StepExecutionWorkerClient,
} from "../contracts/process-project-work-types";
import type { SecretMasker } from "./secret-masker";

const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_BATCH_LINES = 256;
const DEFAULT_MAX_BUFFER_LINES = 10_000;
// Stay under the server-side per-line cap (16k chars) so one long line can't
// fail validation for an entire batch.
const MAX_LINE_CONTENT_LENGTH = 12_000;

/**
 * Strip characters PostgreSQL `text` columns cannot store. Raw devcontainer
 * output (docker/AWS CLI, terminal progress, `init.sh` stderr) routinely
 * contains NUL bytes and other C0 control characters. Zod's `z.string()`
 * accepts them, but the `content text` insert rejects the *entire* batch with
 * `invalid byte sequence for encoding "UTF8": 0x00`. Because the shipper
 * retains and retries the same batch, a single poisoned line permanently stalls
 * the feed. Sanitizing here — the one choke point every stream passes through —
 * guarantees no line can poison a batch.
 *
 * We drop NUL and the C0 control range except the whitespace that is meaningful
 * in log output (tab, newline, carriage return). Lone surrogate code points,
 * which also break UTF-8 encoding, are replaced with the Unicode replacement
 * character.
 */
const sanitizeLogContent = (content: string): string =>
  content
    // NUL + other C0 controls, excluding \t (\x09), \n (\x0A), \r (\x0D).
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    // Unpaired UTF-16 surrogates cannot be encoded as valid UTF-8.
    .replace(/[\uD800-\uDFFF]/g, "\uFFFD");

/**
 * Severity of a diagnostic feed line. Used to filter low-signal noise out of the
 * durable feed/archive. The `conversation` stream is product data and is always
 * shipped regardless of level.
 */
export type LogLevel = StepExecutionLogLevel;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Default minimum severity for the diagnostic (`worker` / `ai-server`) streams.
 * Lines below this are dropped before shipping — they still reach the local
 * pino sink, but never hit Postgres/S3. Overridable via
 * `BOBODDY_LOG_SHIP_LEVEL` so a noisy run can be debugged end-to-end on demand.
 */
const DEFAULT_MIN_SHIP_LEVEL: LogLevel = "info";

const parseLogLevel = (value: string | undefined): LogLevel | undefined => {
  switch (value?.trim().toLowerCase()) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    default:
      return undefined;
  }
};

export type StepExecutionLogShipperDeps = {
  workerClient: Pick<StepExecutionWorkerClient, "appendStepExecutionLogs">;
  stepExecutionId: UuidV7;
  claimToken: string;
  /**
   * Redacts known secret values from every line before it is buffered/shipped.
   * Required: the durable feed (Postgres + S3 archive) must never persist a
   * user's injected secrets. Pass a masker seeded with no values to opt out —
   * it is then a no-op.
   */
  secretMasker: SecretMasker;
  /** Diagnostic sink; shipping failures are logged here, never thrown. */
  // eslint-disable-next-line local/no-unknown-parameter-type
  onError?: (error: unknown) => void;
  flushIntervalMs?: number;
  maxBatchLines?: number;
  maxBufferLines?: number;
  /**
   * Minimum severity shipped for the diagnostic streams (`worker`,
   * `ai-server`). Defaults to `BOBODDY_LOG_SHIP_LEVEL` or `info`.
   */
  minShipLevel?: LogLevel;
};

/**
 * Batches step-execution log lines and ships them to the platform on a timer.
 *
 * GitHub-Actions-style: each line carries a monotonic per-step `seq` so the
 * server feed is an append-only, offset-addressable log and retried batches are
 * idempotent. Shipping is best-effort and decoupled from step execution —
 * failures are reported via {@link StepExecutionLogShipperDeps.onError} and the
 * unsent batch is retained for the next flush, never blocking or failing the
 * step. A bounded buffer drops the oldest lines under sustained backpressure.
 */
export class StepExecutionLogShipper {
  private readonly deps: Required<
    Pick<
      StepExecutionLogShipperDeps,
      "flushIntervalMs" | "maxBatchLines" | "maxBufferLines" | "minShipLevel"
    >
  > &
    StepExecutionLogShipperDeps;
  // 1-based, monotonic. The read API uses an exclusive `from` cursor (seq >
  // from), so starting at 1 makes the initial `from=0` poll return every line.
  private seq = 1;
  private buffer: StepExecutionLogLine[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private stopped = false;

  constructor(deps: StepExecutionLogShipperDeps) {
    this.deps = {
      ...deps,
      flushIntervalMs: deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxBatchLines: deps.maxBatchLines ?? DEFAULT_MAX_BATCH_LINES,
      maxBufferLines: deps.maxBufferLines ?? DEFAULT_MAX_BUFFER_LINES,
      minShipLevel:
        deps.minShipLevel ??
        parseLogLevel(process.env["BOBODDY_LOG_SHIP_LEVEL"]) ??
        DEFAULT_MIN_SHIP_LEVEL,
    };
  }

  start(): void {
    if (this.timer !== null || this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, this.deps.flushIntervalMs);
    // Don't keep the event loop alive solely for log shipping.
    this.timer.unref();
  }

  /**
   * Enqueue a single log line. Cheap and synchronous; flushed on the timer.
   *
   * For the diagnostic streams (`worker`, `ai-server`) a `level` may be supplied
   * (defaulting to `info`); lines below {@link StepExecutionLogShipperDeps.minShipLevel}
   * are dropped so low-signal noise never reaches Postgres/S3. The
   * `conversation` stream is product data and is always shipped regardless of
   * level.
   */
  enqueue(
    stream: StepExecutionLogStream,
    content: string,
    ts?: Date,
    level: LogLevel = "info",
  ): void {
    if (this.stopped) {
      return;
    }
    if (stream !== "conversation" && LEVEL_RANK[level] < LEVEL_RANK[this.deps.minShipLevel]) {
      return;
    }
    // Redact known secret values BEFORE the length cap so truncation operates
    // on already-masked content (a secret can't survive by straddling the cut).
    // Runs for every stream, including `conversation`, which bypasses the level
    // filter above but must still be masked.
    const masked = this.deps.secretMasker.mask(sanitizeLogContent(content));
    this.buffer.push({
      seq: this.seq++, // first line is seq 1
      stream,
      ts: (ts ?? new Date()).toISOString(),
      content:
        masked.length > MAX_LINE_CONTENT_LENGTH
          ? `${masked.slice(0, MAX_LINE_CONTENT_LENGTH)}… [truncated]`
          : masked,
      level,
    });
    if (this.buffer.length > this.deps.maxBufferLines) {
      // Drop oldest under backpressure; keeps memory bounded. Gaps in seq are
      // tolerated by the offset-read contract.
      this.buffer.splice(
        0,
        this.buffer.length - this.deps.maxBufferLines,
      );
    }
  }

  /** Flush all buffered lines, draining in capped batches. Never throws. */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.slice(0, this.deps.maxBatchLines);
        try {
          await this.deps.workerClient.appendStepExecutionLogs({
            stepExecutionId: this.deps.stepExecutionId,
            claimToken: this.deps.claimToken,
            lines: batch,
          });
        } catch (error) {
          // Retain the unsent batch for the next flush; report and stop draining.
          this.deps.onError?.(error);
          return;
        }
        this.buffer.splice(0, batch.length);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Stop the timer and flush any remaining lines a final time. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
