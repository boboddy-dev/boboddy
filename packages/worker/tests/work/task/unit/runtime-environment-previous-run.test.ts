/**
 * Both launch orchestrators write a steered rerun's previous-run findings and
 * transcript next to the current-execution metadata, and an unreadable
 * transcript does not fail the launch. Every external boundary is faked (see
 * `orchestrator-launch-fakes.ts` and `local-noworkspace-runtime-environment.test.ts`).
 * `writePreviousRunFiles` itself renders only the conversation stream and
 * still writes findings when the transcript is unavailable.
 */
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LogLine, TaskLogLinesResult } from "@boboddy/platform-client";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task/infra/local-project-runtime-environment";
import { DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator } from "../../../../src/work/task/infra/local-noworkspace-runtime-environment";
import {
  writePreviousRunFiles,
  type PreviousRunFilesInput,
} from "../../../../src/work/task/application/write-previous-run-files";
import {
  HostOpencodeBootstrap,
  type HostStartInput,
  type HostStartResult,
} from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const FINDINGS = ".boboddy/previous-run/findings.json";
const TRANSCRIPT = ".boboddy/previous-run/transcript.txt";

function previousRunInput(
  loadLogLines: PreviousRunFilesInput["loadLogLines"],
  findingsJson: PreviousRunFilesInput["run"]["findingsJson"] = {
    summary: "half done",
  },
): PreviousRunFilesInput {
  return {
    run: {
      taskId: "0199a000-0000-7000-8000-000000000003",
      status: "failed",
      transcriptRelativePath: TRANSCRIPT,
      findingsRelativePath: FINDINGS,
      findingsJson,
    },
    stepKey: "build",
    loadLogLines,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

class FakeHostOpencodeBootstrap extends HostOpencodeBootstrap {
  override start(input: HostStartInput): Promise<HostStartResult> {
    const agentLogDirectory = path.join(input.sessionAgentHomeDir, "log");
    return Promise.resolve({
      agentBaseUrl: "http://127.0.0.1:54999",
      serverPassword: "password",
      agentLogDirectory,
      agentLogPath: path.join(agentLogDirectory, "opencode-serve.log"),
      pid: 4242,
    });
  }
  override stop(): void {
    return undefined;
  }
}

describe("launch with a previousRun", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "orchestrator-provider-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function workspaceOrchestrator() {
    const log: CallLog = [];
    return new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      buildOrchestratorFakeDeps({ workspacePath, providerOutputDir, log }),
    );
  }

  test("the workspace launch writes the previous run's findings and transcript", async () => {
    await workspaceOrchestrator().launch({
      ...buildLaunchInput(),
      startAgent: false,
      previousRun: previousRunInput(() =>
        Promise.resolve({ lines: [], source: "archive" }),
      ),
    });

    expect(
      JSON.parse(await readFile(path.join(workspacePath, FINDINGS), "utf8")),
    ).toEqual({ summary: "half done" });
    expect(
      await readFile(path.join(workspacePath, TRANSCRIPT), "utf8"),
    ).toContain("Logs for step build (complete)");
  });

  test("the workspace launch succeeds without a transcript when the logs cannot be read", async () => {
    const env = await workspaceOrchestrator().launch({
      ...buildLaunchInput(),
      startAgent: false,
      previousRun: previousRunInput(() =>
        Promise.reject(new Error("Failed to download log archive (HTTP 500).")),
      ),
    });

    expect(env.runtimeContainerId).not.toBeNull();
    expect(await exists(path.join(workspacePath, FINDINGS))).toBe(true);
    expect(await exists(path.join(workspacePath, TRANSCRIPT))).toBe(false);
  });

  test("a run that is not steered writes nothing under .boboddy/previous-run", async () => {
    await workspaceOrchestrator().launch({
      ...buildLaunchInput(),
      startAgent: false,
    });

    expect(
      await exists(path.join(workspacePath, ".boboddy/previous-run")),
    ).toBe(false);
  });

  test("the no-workspace launch writes the files into its temp working dir", async () => {
    const fakes = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log: [],
    });
    const orchestrator =
      new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(undefined, {
        payloadProvisioner: fakes.payloadProvisioner,
        providerAccessResolver: fakes.providerAccessResolver,
        runtimeConfigMaterializer: fakes.runtimeConfigMaterializer,
        hostOpencodeBootstrap: new FakeHostOpencodeBootstrap(),
        loadCredentials: fakes.loadCredentials,
      });
    const sessionId = createUuidV7();

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      sessionId,
      repo: { mode: "none" },
      previousRun: previousRunInput(
        () => Promise.resolve({ lines: [], source: "live" }),
        null,
      ),
    });
    try {
      expect(
        await readFile(path.join(env.workspacePath, FINDINGS), "utf8"),
      ).toBe("null\n");
      expect(
        await readFile(path.join(env.workspacePath, TRANSCRIPT), "utf8"),
      ).toContain("Logs for step build (live snapshot");
    } finally {
      await env.cleanup();
    }
  });
});

function conversationLine(seq: number, role: string, text: string): LogLine {
  return {
    seq,
    stream: "conversation",
    ts: "2026-10-16T10:00:00.000Z",
    content: JSON.stringify({
      kind: "text",
      messageId: `m${String(seq)}`,
      partId: `p${String(seq)}`,
      role,
      text,
    }),
    level: "info",
  };
}

describe("writePreviousRunFiles", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "previous-run-files-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("writes the findings and the rendered conversation transcript", async () => {
    const loaded: TaskLogLinesResult = {
      source: "archive",
      lines: [
        conversationLine(1, "user", "Find the bug."),
        conversationLine(2, "assistant", "The bug is in parse()."),
        {
          seq: 3,
          stream: "worker",
          ts: "2026-10-16T10:00:01.000Z",
          content: "worker chatter",
          level: "info",
        },
      ],
    };

    const result = await writePreviousRunFiles(
      workspace,
      previousRunInput(() => Promise.resolve(loaded)),
    );

    expect(result).toEqual({
      findingsPath: path.join(workspace, FINDINGS),
      transcriptPath: path.join(workspace, TRANSCRIPT),
    });
    expect(
      JSON.parse(await readFile(path.join(workspace, FINDINGS), "utf8")),
    ).toEqual({ summary: "half done" });
    const transcript = await readFile(path.join(workspace, TRANSCRIPT), "utf8");
    expect(transcript).toContain("Logs for step build (complete)");
    expect(transcript).toContain("Find the bug.");
    expect(transcript).toContain("The bug is in parse().");
    expect(transcript).not.toContain("worker chatter");
  });

  test("skips the transcript but still writes findings when the read quota is exceeded", async () => {
    const logged: string[] = [];
    const result = await writePreviousRunFiles(
      workspace,
      previousRunInput(() =>
        Promise.resolve<TaskLogLinesResult>({
          unavailable: "log archive read quota exceeded (402)",
        }),
      ),
      {
        debug: () => undefined,
        log: (_scope, message) => logged.push(message),
        error: () => undefined,
      },
    );

    expect(result.transcriptPath).toBeNull();
    expect(await exists(path.join(workspace, TRANSCRIPT))).toBe(false);
    expect(await exists(path.join(workspace, FINDINGS))).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("previous run transcript skipped");
  });
});
