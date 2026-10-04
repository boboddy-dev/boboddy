/**
 * The clone and work-branch timing lines must reach the step's shipped log
 * before the step completes. Covers the `launch()` input `logger`, and the
 * path `launchRuntimeEnvironment` -> `launch()` -> real cached clone -> tee
 * logger -> log shipper.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../../../../src/runtime/runtime-service/application/git-clone-service";
import { launchRuntimeEnvironment } from "../../../../src/work/step-execution/application/process-claimed-step-execution-launch";
import { StepExecutionLogStream } from "../../../../src/work/step-execution/application/start-step-execution-log-streaming";
import type {
  ProcessProjectWorkDeps,
  StepExecutionLogLine,
  StepExecutionWorkerClient,
} from "../../../../src/work/step-execution/contracts/process-project-work-types";
import { noopReporter } from "../../../../src/work/step-execution/contracts/work-reporter";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-project-runtime-environment";
import { setupCachedCloneFixture } from "../../../runtime/runtime-service/unit/cached-git-clone-fixtures";
import {
  git,
  writeRepoFile,
} from "../../../runtime/runtime-service/unit/git-test-fixtures";
import { createRecordingWorkLogger } from "../../../support/recording-work-logger";
import {
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  requestedByUserId,
} from "./helpers/claimed-step-execution-fixtures";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  DEVCONTAINER_CONFIG_PATH,
  DEVCONTAINER_JSON,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const CLONED_LINE = /^repository cloned in \d+\.\ds$/u;
const BRANCH_LINE = /^work branch prepared in \d+\.\ds$/u;

class RecordingCloneService implements GitCloneService {
  readonly inputs: CloneRepositoryInput[] = [];
  async cloneRepository(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    this.inputs.push(input);
    await mkdir(path.join(input.workspacePath, ".devcontainer"), {
      recursive: true,
    });
    await writeFile(
      path.join(input.workspacePath, DEVCONTAINER_CONFIG_PATH),
      DEVCONTAINER_JSON,
      "utf8",
    );
    return { resolvedBranch: "main" };
  }
}

describe("launch() logger input", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "launch-log-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "launch-log-provider-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function orchestratorWith(clone: GitCloneService) {
    const log: CallLog = [];
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
    });
    return new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      { ...deps, gitCloneService: clone },
    );
  }

  test("passes the logger to the clone and logs the overall clone and work-branch times at info level", async () => {
    const clone = new RecordingCloneService();
    const { entries, logger } = createRecordingWorkLogger();

    await orchestratorWith(clone).launch({
      ...buildLaunchInput(),
      stepKey: "build",
      logger,
    });

    expect(clone.inputs[0]?.logger).toBe(logger);
    const infoLines = entries
      .filter((entry) => entry.level === "log")
      .map((entry) => entry.message);
    expect(infoLines).toHaveLength(2);
    expect(infoLines[0]).toMatch(CLONED_LINE);
    expect(infoLines[1]).toMatch(BRANCH_LINE);
    expect(entries.some((entry) => entry.level === "debug")).toBe(false);
  });

  test("a dry-run style launch without a step key still times the clone", async () => {
    const { entries, logger } = createRecordingWorkLogger();

    await orchestratorWith(new RecordingCloneService()).launch({
      ...buildLaunchInput(),
      logger,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toMatch(CLONED_LINE);
  });

  test("launches without a logger and hands the clone none", async () => {
    const clone = new RecordingCloneService();

    await orchestratorWith(clone).launch({
      ...buildLaunchInput(),
      stepKey: "build",
    });

    expect(clone.inputs[0]?.logger).toBeUndefined();
  });
});

describe("launchRuntimeEnvironment git timing lines reach the shipper", () => {
  const SHIP_LEVEL = "BOBODDY_LOG_SHIP_LEVEL";
  let savedShipLevel: string | undefined;
  let providerOutputDir: string;

  beforeEach(async () => {
    savedShipLevel = process.env[SHIP_LEVEL];
    Reflect.deleteProperty(process.env, SHIP_LEVEL);
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "launch-log-provider-"),
    );
  });

  afterEach(async () => {
    if (savedShipLevel === undefined) {
      Reflect.deleteProperty(process.env, SHIP_LEVEL);
    } else {
      process.env[SHIP_LEVEL] = savedShipLevel;
    }
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  async function shipLaunchLines() {
    const fx = await setupCachedCloneFixture();
    await writeRepoFile(
      fx.seed,
      DEVCONTAINER_CONFIG_PATH,
      `${DEVCONTAINER_JSON}\n`,
    );
    await git(fx.seed, ["add", "-A"]);
    await git(fx.seed, ["commit", "--no-gpg-sign", "-m", "add devcontainer"]);
    await git(fx.seed, ["push", "origin", "main"]);

    const shipped: StepExecutionLogLine[] = [];
    let completeCalls = 0;
    const workerClient: StepExecutionWorkerClient = {
      ...createWorkerClient(),
      appendStepExecutionLogs: (input) => {
        shipped.push(...input.lines);
        return Promise.resolve({ nextOffset: input.lines.at(-1)?.seq ?? 0 });
      },
      completeStepExecution: () => {
        completeCalls += 1;
        return Promise.reject(new Error("launch must not complete the step"));
      },
    };
    const baseLogger = createRecordingWorkLogger();
    const stream = new StepExecutionLogStream({
      workerClient,
      logger: baseLogger.logger,
      stepExecutionId: createUuidV7(),
      claimToken: "claim-token",
    });

    const log: CallLog = [];
    const fakeDeps = buildOrchestratorFakeDeps({
      workspacePath: fx.workspacePath,
      providerOutputDir,
      log,
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
      stepExecutionId: createUuidV7(),
    });
    await stream.flush();

    expect(completeCalls).toBe(0);
    await stream.stop();
    await rm(fx.root, { recursive: true, force: true });
    return { shipped, baseEntries: baseLogger.entries };
  }

  test("ships mirror, local clone, overall clone and work-branch timings at info level before completion", async () => {
    const { shipped, baseEntries } = await shipLaunchLines();

    const worker = shipped.filter((line) => line.stream === "worker");
    const content = worker.map((line) => line.content);
    const gitCacheLines = content.filter((line) =>
      line.startsWith("[git-cache] "),
    );
    expect(gitCacheLines).toHaveLength(2);
    expect(gitCacheLines[0]).toMatch(
      /^\[git-cache\] git-cache: mirror created in \d+\.\ds \(miss\)$/u,
    );
    expect(gitCacheLines[1]).toMatch(
      /^\[git-cache\] git-cache: local clone in \d+\.\ds$/u,
    );
    expect(
      content.filter((line) =>
        /^\[runtime\] repository cloned in /u.test(line),
      ),
    ).toHaveLength(1);
    expect(
      content.filter((line) =>
        /^\[runtime\] work branch prepared in \d+\.\ds$/u.test(line),
      ),
    ).toHaveLength(1);
    const timingLines = worker.filter(
      (line) =>
        line.content.startsWith("[git-cache] ") ||
        /^\[runtime\] (repository cloned|work branch prepared)/u.test(
          line.content,
        ),
    );
    expect(timingLines).toHaveLength(4);
    expect(timingLines.every((line) => line.level === "info")).toBe(true);
    expect(baseEntries.some((entry) => entry.level === "debug")).toBe(false);
  });
});
