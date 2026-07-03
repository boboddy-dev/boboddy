import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type {
  ProjectWorkLogger,
  StepExecutionWorkerClient,
} from "../contracts/process-project-work-types";
import { StepExecutionLogShipper } from "./step-execution-log-shipper";
import { OpencodeLogTail } from "./opencode-log-tail";
import { OpencodeConversationStreamer } from "./opencode-conversation-streamer";
import { AGENT_SERVE_LOG_FILENAME } from "../../../runtime/runtime-service/infra/devcontainer-opencode-bootstrap";

const formatWorkerLogLine = (
  level: "debug" | "log" | "error",
  scope: string,
  message: string,
  details?: Record<string, unknown>,
): string => {
  const prefix = level === "error" ? "ERROR " : level === "debug" ? "DEBUG " : "";
  const base = `${prefix}[${scope}] ${message}`;
  if (!details || Object.keys(details).length === 0) {
    return base;
  }
  let serializedDetails: string;
  try {
    serializedDetails = JSON.stringify(details, replaceErrors);
  } catch {
    serializedDetails = "[unserializable details]";
  }
  // The shipper enforces the per-line length cap centrally.
  return `${base} ${serializedDetails}`;
};

// JSON.stringify drops Error fields by default; surface message/stack instead.
// eslint-disable-next-line local/no-unknown-parameter-type
const replaceErrors = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
};

/**
 * Wraps a {@link ProjectWorkLogger} so each call is forwarded to the original
 * sink AND enqueued into the live feed as a `worker`-stream line.
 */
const createStreamingLogger = (
  baseLogger: ProjectWorkLogger,
  shipper: StepExecutionLogShipper,
): ProjectWorkLogger => ({
  debug: (scope, message, details) => {
    // Tee to the local sink, but ship at `debug` so the shipper drops it from
    // the durable feed unless the ship level is lowered. Keeps high-frequency
    // noise out of Postgres/S3.
    baseLogger.debug(scope, message, details);
    shipper.enqueue(
      "worker",
      formatWorkerLogLine("debug", scope, message, details),
      undefined,
      "debug",
    );
  },
  log: (scope, message, details) => {
    baseLogger.log(scope, message, details);
    shipper.enqueue(
      "worker",
      formatWorkerLogLine("log", scope, message, details),
      undefined,
      "info",
    );
  },
  error: (scope, message, details) => {
    baseLogger.error(scope, message, details);
    shipper.enqueue(
      "worker",
      formatWorkerLogLine("error", scope, message, details),
      undefined,
      "error",
    );
  },
});

/**
 * Live log streaming for a claimed step execution (GitHub-Actions-style).
 *
 * Created as early as possible — right after the claim — so worker-side
 * diagnostics from the *entire* lifecycle (runtime setup, clone, container
 * build, OpenCode bootstrap, monitoring) are streamed to the platform, not just
 * the monitoring phase. The agent's in-container log is attached later via
 * {@link attachOpencodeTail}, once the runtime container exists.
 */
export class StepExecutionLogStream {
  readonly shipper: StepExecutionLogShipper;
  /**
   * A {@link ProjectWorkLogger} that behaves like the one passed in (still
   * writing to pino/file/TTY) but also tees every line into the live feed as
   * the `worker` stream. Use this for all logging during the claimed step.
   */
  readonly logger: ProjectWorkLogger;
  private readonly baseLogger: ProjectWorkLogger;
  private readonly stepExecutionId: UuidV7;
  private tail: OpencodeLogTail | null = null;
  private conversation: OpencodeConversationStreamer | null = null;

  constructor(input: {
    workerClient: Pick<StepExecutionWorkerClient, "appendStepExecutionLogs">;
    logger: ProjectWorkLogger;
    stepExecutionId: UuidV7;
    claimToken: string;
  }) {
    this.baseLogger = input.logger;
    this.stepExecutionId = input.stepExecutionId;
    this.shipper = new StepExecutionLogShipper({
      workerClient: input.workerClient,
      stepExecutionId: input.stepExecutionId,
      claimToken: input.claimToken,
      onError: (error) => {
        // Use the base logger to avoid recursively shipping shipper errors.
        this.baseLogger.error("worker", "Failed to ship step execution logs", {
          stepExecutionId: this.stepExecutionId,
          error,
        });
      },
    });
    this.shipper.start();
    this.logger = createStreamingLogger(this.baseLogger, this.shipper);
  }

  /**
   * Begin tailing the in-container OpenCode log into the `ai-server` stream.
   * Safe to call once the runtime container is up; no-op if called more than
   * once.
   */
  attachOpencodeTail(input: {
    runtimeContainerId: string;
    opencodeLogDirectory: string;
  }): void {
    if (this.tail !== null) {
      return;
    }
    this.tail = new OpencodeLogTail({
      containerId: input.runtimeContainerId,
      logPath: `${input.opencodeLogDirectory}/${AGENT_SERVE_LOG_FILENAME}`,
      shipper: this.shipper,
      onError: (error) => {
        this.baseLogger.error("worker", "Failed to tail OpenCode log", {
          stepExecutionId: this.stepExecutionId,
          error,
        });
      },
    });
    this.tail.start();
  }

  /**
   * Begin streaming the agent conversation (model text, reasoning, tool calls)
   * into the `conversation` stream by subscribing to the in-container OpenCode
   * event stream. Safe to call once the agent session exists; no-op if called
   * more than once.
   */
  attachConversationStream(input: {
    agentBaseUrl: string;
    workspaceFolder: string;
    sessionId: string;
  }): void {
    if (this.conversation !== null) {
      return;
    }
    this.conversation = new OpencodeConversationStreamer({
      agentBaseUrl: input.agentBaseUrl,
      workspaceFolder: input.workspaceFolder,
      sessionId: input.sessionId,
      shipper: this.shipper,
      onError: (error) => {
        this.baseLogger.error(
          "worker",
          "Failed to stream OpenCode conversation",
          {
            stepExecutionId: this.stepExecutionId,
            error,
          },
        );
      },
    });
    this.conversation.start();
  }

  /** Stop tailing and flush any remaining lines a final time. */
  async stop(): Promise<void> {
    this.tail?.stop();
    this.conversation?.stop();
    await this.shipper.stop();
  }
}
