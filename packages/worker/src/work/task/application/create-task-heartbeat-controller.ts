import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import { resolveProjectWorkLogger } from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  TaskWorkerClient,
} from "../contracts/process-project-work-types";

function getHeartbeatPollDelayMs(leaseDurationSeconds: number) {
  return Math.max(1_000, Math.floor((leaseDurationSeconds * 1_000) / 2));
}

export function createTaskHeartbeatController(
  client: TaskWorkerClient,
  deps: Pick<ProcessProjectWorkDeps, "sleep" | "logger">,
  input: {
    taskId: UuidV7;
    claimToken: string;
    leaseDurationSeconds: number;
  },
) {
  const logger = resolveProjectWorkLogger(deps);
  // Heartbeat ticks are high-frequency, low-signal. Log them at `debug` so they
  // stay in local diagnostics but are dropped from the durable feed/archive
  // (keeps Postgres/S3 volume down).
  const pollDelayMs = getHeartbeatPollDelayMs(input.leaseDurationSeconds);

  logger.debug("heartbeat", "Starting heartbeat loop", {
    taskId: input.taskId,
    leaseDurationSeconds: input.leaseDurationSeconds,
    pollDelayMs,
  });

  let resolveStopSignal: (() => void) | null = null;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve;
  });
  let activePollTimeout: ReturnType<typeof setTimeout> | null = null;

  function waitForNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      activePollTimeout = setTimeout(() => {
        activePollTimeout = null;
        resolve();
      }, pollDelayMs);
    });
  }

  const runLoop = (async () => {
    for (;;) {
      const shouldStop = await Promise.race([
        waitForNextPoll().then(() => false),
        stopSignal.then(() => true),
      ]);
      if (shouldStop) {
        return;
      }

      try {
        logger.debug("heartbeat", "Sending heartbeat", {
          taskId: input.taskId,
          leaseDurationSeconds: input.leaseDurationSeconds,
        });
        await client.heartbeatTask({
          taskId: input.taskId,
          claimToken: input.claimToken,
          leaseDurationSeconds: input.leaseDurationSeconds,
        });
        logger.debug("heartbeat", "Heartbeat accepted", {
          taskId: input.taskId,
        });
      } catch (error) {
        logger.error("heartbeat", "Heartbeat failed", {
          taskId: input.taskId,
          error,
        });
      }
    }
  })();

  return {
    async stop() {
      logger.debug("heartbeat", "Stopping heartbeat loop", {
        taskId: input.taskId,
      });
      if (activePollTimeout !== null) {
        clearTimeout(activePollTimeout);
        activePollTimeout = null;
      }
      resolveStopSignal?.();
      await runLoop;
      logger.debug("heartbeat", "Heartbeat loop stopped", {
        taskId: input.taskId,
      });
    },
  };
}
