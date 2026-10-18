/**
 * `writePreviousRunFiles`: a steered rerun gets its previous run's findings and
 * conversation transcript in the workspace. The transcript is best-effort (an
 * unreadable log never fails the launch and never leaves a partial file), and
 * neither file reaches a work-branch commit.
 */
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LogLine, TaskLogLinesResult } from "@boboddy/platform-client";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import type { PreviousRunContract } from "../../../../src/work/task/contracts/task-contracts";
import { writePreviousRunFiles } from "../../../../src/work/task/application/write-previous-run-files";
import { WORK_BRANCH_EXCLUDE_PATHS } from "../../../../src/work/task/infra/work-branch-manager";
import {
  git,
  writeRepoFile,
} from "../../../runtime/runtime-service/unit/git-test-fixtures";

const TRANSCRIPT = ".boboddy/previous-run/transcript.txt";
const FINDINGS = ".boboddy/previous-run/findings.json";

function previousRun(
  overrides: Partial<PreviousRunContract> = {},
): PreviousRunContract {
  return {
    taskId: "0199a000-0000-7000-8000-000000000001",
    status: "succeeded",
    transcriptRelativePath: TRANSCRIPT,
    findingsRelativePath: FINDINGS,
    findingsJson: { summary: "found the bug", confidence: 0.8 },
    ...overrides,
  };
}

function conversationLine(
  seq: number,
  event: {
    kind: "text";
    messageId: string;
    partId: string;
    role: string;
    text: string;
  },
): LogLine {
  return {
    seq,
    stream: "conversation",
    ts: "2026-10-16T10:00:00.000Z",
    content: JSON.stringify(event),
    level: "info",
  };
}

const LOADED_LINES: TaskLogLinesResult = {
  source: "archive",
  lines: [
    conversationLine(1, {
      kind: "text",
      messageId: "m1",
      partId: "p1",
      role: "user",
      text: "Find the bug.",
    }),
    conversationLine(2, {
      kind: "text",
      messageId: "m2",
      partId: "p2",
      role: "assistant",
      text: "The bug is in parse().",
    }),
    {
      seq: 3,
      stream: "worker",
      ts: "2026-10-16T10:00:01.000Z",
      content: "worker chatter",
      level: "info",
    },
  ],
};

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
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
    const result = await writePreviousRunFiles(workspace, {
      run: previousRun(),
      stepKey: "investigate",
      loadLogLines: () => Promise.resolve(LOADED_LINES),
    });

    expect(result).toEqual({
      findingsPath: path.join(workspace, FINDINGS),
      transcriptPath: path.join(workspace, TRANSCRIPT),
    });
    expect(
      JSON.parse(await readFile(path.join(workspace, FINDINGS), "utf8")),
    ).toEqual({ summary: "found the bug", confidence: 0.8 });
    const transcript = await readFile(path.join(workspace, TRANSCRIPT), "utf8");
    expect(transcript).toContain("Logs for step investigate (complete)");
    expect(transcript).toContain("Find the bug.");
    expect(transcript).toContain("The bug is in parse().");
    expect(transcript).not.toContain("worker chatter");
  });

  test("writes null findings when the previous run submitted none", async () => {
    await writePreviousRunFiles(workspace, {
      run: previousRun({ findingsJson: null }),
      stepKey: "investigate",
      loadLogLines: () => Promise.resolve(LOADED_LINES),
    });

    expect(await readFile(path.join(workspace, FINDINGS), "utf8")).toBe(
      "null\n",
    );
  });

  test.each([
    [
      "the read quota is exceeded",
      () =>
        Promise.resolve<TaskLogLinesResult>({
          unavailable: "log archive read quota exceeded (402)",
        }),
    ],
    [
      "no archive URL can be presigned",
      () =>
        Promise.resolve<TaskLogLinesResult>({
          unavailable: "no log archive is available",
        }),
    ],
    [
      "the archive download throws",
      () =>
        Promise.reject<TaskLogLinesResult>(
          new Error("Failed to download log archive (HTTP 403)."),
        ),
    ],
  ])(
    "skips the transcript but still writes findings when %s",
    async (_case, loadLogLines) => {
      const logged: string[] = [];
      const result = await writePreviousRunFiles(
        workspace,
        { run: previousRun(), stepKey: "investigate", loadLogLines },
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
    },
  );

  test("the written files never reach a work-branch commit", async () => {
    await git(workspace, ["init", "-b", "main"]);
    await git(workspace, ["config", "user.email", "workspace@boboddy.dev"]);
    await git(workspace, ["config", "user.name", "Workspace"]);
    await writeRepoFile(workspace, "README.md", "hello\n");
    await git(workspace, ["add", "-A"]);
    await git(workspace, ["commit", "--no-gpg-sign", "-m", "init"]);

    await writePreviousRunFiles(workspace, {
      run: previousRun(),
      stepKey: "investigate",
      loadLogLines: () => Promise.resolve(LOADED_LINES),
    });
    await writeRepoFile(workspace, "fix.ts", "export const fixed = true;\n");

    const result = await new GitCliCommitPushService().commitAll({
      workspacePath: workspace,
      message: "boboddy: steered rerun",
      excludePaths: WORK_BRANCH_EXCLUDE_PATHS,
    });

    expect(result.committed).toBe(true);
    const committed = await git(workspace, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    expect(committed.split("\n")).toEqual(["fix.ts"]);
    expect(await exists(path.join(workspace, TRANSCRIPT))).toBe(true);
  });
});
