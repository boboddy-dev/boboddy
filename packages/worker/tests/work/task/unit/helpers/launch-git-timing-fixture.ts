/**
 * Runs `launchRuntimeEnvironment` through the real workspace orchestrator and a
 * real cached clone, teeing its logger into a `TaskLogStreaming` shipper, and
 * returns every shipped line. Importers must register
 * `afterAll(disposeMirrorFixtureTemplate)`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "bun:test";
import { createUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import { launchRuntimeEnvironment } from "../../../../../src/work/task/application/process-claimed-task-launch";
import { TaskLogStreaming } from "../../../../../src/work/task/application/start-task-log-streaming";
import type {
  ProcessProjectWorkDeps,
  TaskLogLine,
  TaskWorkerClient,
} from "../../../../../src/work/task/contracts/process-project-work-types";
import { noopReporter } from "../../../../../src/work/task/contracts/work-reporter";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../../src/work/task/infra/local-project-runtime-environment";
import { setupCachedCloneFixture } from "../../../../runtime/runtime-service/unit/cached-git-clone-fixtures";
import {
  git,
  writeRepoFile,
} from "../../../../runtime/runtime-service/unit/git-test-fixtures";
import { createRecordingWorkLogger } from "../../../../support/recording-work-logger";
import {
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  requestedByUserId,
} from "./claimed-task-fixtures";
import {
  buildOrchestratorFakeDeps,
  DEVCONTAINER_CONFIG_PATH,
  DEVCONTAINER_JSON,
} from "./orchestrator-launch-fakes";

export { disposeMirrorFixtureTemplate } from "../../../../runtime/runtime-service/unit/cached-git-clone-fixtures";

const SHIP_LEVEL = "BOBODDY_LOG_SHIP_LEVEL";

export async function shipLaunchGitTimingLines() {
  const savedShipLevel = process.env[SHIP_LEVEL];
  Reflect.deleteProperty(process.env, SHIP_LEVEL);
  const providerOutputDir = await mkdtemp(
    path.join(os.tmpdir(), "launch-log-provider-"),
  );
  const fx = await setupCachedCloneFixture();
  try {
    await writeRepoFile(
      fx.seed,
      DEVCONTAINER_CONFIG_PATH,
      `${DEVCONTAINER_JSON}\n`,
    );
    await git(fx.seed, ["add", "-A"]);
    await git(fx.seed, ["commit", "--no-gpg-sign", "-m", "add devcontainer"]);
    await git(fx.seed, ["push", "origin", "main"]);

    const shipped: TaskLogLine[] = [];
    let completeCalls = 0;
    const workerClient: TaskWorkerClient = {
      ...createWorkerClient(),
      appendTaskLogs: (input) => {
        shipped.push(...input.lines);
        return Promise.resolve({ nextOffset: input.lines.at(-1)?.seq ?? 0 });
      },
      completeTask: () => {
        completeCalls += 1;
        return Promise.reject(new Error("launch must not complete the step"));
      },
    };
    const baseLogger = createRecordingWorkLogger();
    const stream = new TaskLogStreaming({
      workerClient,
      logger: baseLogger.logger,
      taskId: createUuidV7(),
      claimToken: "claim-token",
    });

    const fakeDeps = buildOrchestratorFakeDeps({
      workspacePath: fx.workspacePath,
      providerOutputDir,
      log: [],
    });
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      { ...fakeDeps, gitCloneService: fx.service },
    );
    const deps = {
      workerClient,
      createRunTracker,
      runtimeEnvironmentOrchestrator: orchestrator,
      agentRunner: {
        promptAsync: vi.fn(),
        getSessionStatus: vi.fn(),
        sendRetryPrompt: vi.fn(),
      },
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: stream.logger,
    } satisfies ProcessProjectWorkDeps;

    await launchRuntimeEnvironment(deps, {
      startAgent: true,
      localRuntimeSessionId: createUuidV7(),
      workerContext: {
        ...createWorkerContext("workspace"),
        gitUrl: fx.remote,
      },
      requestedByUserId,
      reporter: noopReporter,
      taskId: createUuidV7(),
    });
    await stream.flush();
    const completeCallsBeforeStop = completeCalls;
    await stream.stop();
    return {
      shipped,
      baseEntries: baseLogger.entries,
      completeCalls: completeCallsBeforeStop,
    };
  } finally {
    if (savedShipLevel === undefined) {
      Reflect.deleteProperty(process.env, SHIP_LEVEL);
    } else {
      process.env[SHIP_LEVEL] = savedShipLevel;
    }
    await rm(fx.root, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  }
}
