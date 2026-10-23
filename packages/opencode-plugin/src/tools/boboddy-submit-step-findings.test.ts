import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { submitArtifact } from "./boboddy-submit-artifact";
import {
  resolveFindingsWorktree,
  submitStepFindings,
} from "./boboddy-submit-step-findings";

const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".boboddy/current-execution/execution.json";

const ARTIFACT_RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["summary", "reproVideo", "screenshot"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    reproVideo: {
      anyOf: [
        { type: "string", "x-boboddy-artifact": { accept: [".webm"] } },
        { type: "null" },
      ],
    },
    screenshot: { type: "string", "x-boboddy-artifact": { accept: [".png"] } },
  },
};

async function writeCurrentExecutionInfo(
  workspacePath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const currentExecutionDirectory = path.join(
    workspacePath,
    ".boboddy/current-execution",
  );
  await mkdir(currentExecutionDirectory, { recursive: true });
  await Bun.write(
    path.join(workspacePath, CURRENT_EXECUTION_INFO_RELATIVE_PATH),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

describe("boboddySubmitStepFindings", () => {
  test.concurrent("keeps non-root worktrees unchanged", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-submit-findings-"),
    );

    expect(await resolveFindingsWorktree(workspacePath)).toBe(workspacePath);
  });

  test.concurrent(
    "throws when the current execution metadata file is missing",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-submit-findings-"),
      );

      try {
        await submitStepFindings(
          { findingsJson: { summary: "done" } },
          workspacePath,
        );
        throw new Error("Expected missing current execution metadata to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "Current execution metadata file not found",
        );
      }
    },
  );

  test.concurrent(
    "writes the findings file after validating against the stored schema",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-submit-findings-"),
      );

      await writeCurrentExecutionInfo(workspacePath, {
        taskId: "task-id",
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
          },
        },
      });

      const result = await submitStepFindings(
        { findingsJson: { summary: "done" } },
        workspacePath,
      );

      expect(JSON.parse(result)).toEqual({
        ok: true,
        outputPath: ".boboddy/step-findings-submission.json",
      });
      expect(
        JSON.parse(
          await readFile(
            path.join(workspacePath, ".boboddy/step-findings-submission.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        findingsJson: { summary: "done" },
      });
    },
  );

  test.concurrent(
    "accepts draft 2020-12 schemas written by task metadata",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-submit-findings-"),
      );

      await writeCurrentExecutionInfo(workspacePath, {
        taskId: "task-id",
        resultSchemaJson: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["confidence"],
          additionalProperties: false,
          properties: {
            confidence: { type: "number" },
          },
        },
      });

      const result = await submitStepFindings(
        { findingsJson: { confidence: 1 } },
        workspacePath,
      );

      expect(JSON.parse(result)).toEqual({
        ok: true,
        outputPath: ".boboddy/step-findings-submission.json",
      });
    },
  );

  test.concurrent(
    "fills artifact fields in from submitted artifacts",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-submit-findings-"),
      );
      await writeCurrentExecutionInfo(workspacePath, {
        taskId: "task-id",
        resultSchemaJson: ARTIFACT_RESULT_SCHEMA,
      });
      await writeFile(path.join(workspacePath, "shot.png"), "png");
      await submitArtifact(
        { path: "shot.png", field: "screenshot" },
        workspacePath,
      );

      await submitStepFindings(
        { findingsJson: { summary: "done" } },
        workspacePath,
      );

      expect(
        JSON.parse(
          await readFile(
            path.join(workspacePath, ".boboddy/step-findings-submission.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        findingsJson: {
          summary: "done",
          screenshot: "screenshot.png",
          reproVideo: null,
        },
      });
    },
  );

  test("reports every artifact and schema problem in one error", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "boboddy-submit-findings-"),
    );
    await writeCurrentExecutionInfo(workspacePath, {
      taskId: "task-id",
      resultSchemaJson: ARTIFACT_RESULT_SCHEMA,
    });

    expect(
      submitStepFindings(
        { findingsJson: { summary: 1, reproVideo: "/tmp/video.webm" } },
        workspacePath,
      ),
    ).rejects.toThrowErrorMatchingSnapshot();
  });

  test.concurrent(
    "rejects a submitted artifact whose stored file is gone",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-submit-findings-"),
      );
      await writeCurrentExecutionInfo(workspacePath, {
        taskId: "task-id",
        resultSchemaJson: ARTIFACT_RESULT_SCHEMA,
      });
      await writeFile(path.join(workspacePath, "shot.png"), "png");
      await submitArtifact(
        { path: "shot.png", field: "screenshot" },
        workspacePath,
      );
      await rm(
        path.join(workspacePath, ".boboddy/step-artifacts/screenshot.png"),
      );

      expect(
        submitStepFindings(
          { findingsJson: { summary: "done" } },
          workspacePath,
        ),
      ).rejects.toThrow(
        "`screenshot` was submitted as screenshot.png, but .boboddy/step-artifacts/screenshot.png is missing or empty.",
      );
    },
  );

  test.concurrent(
    "rejects findings that do not match the stored schema",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-submit-findings-"),
      );

      await writeCurrentExecutionInfo(workspacePath, {
        taskId: "task-id",
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string" },
          },
        },
      });

      try {
        await submitStepFindings(
          { findingsJson: { summary: 123 } },
          workspacePath,
        );
        throw new Error("Expected invalid findings to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "findingsJson does not match resultSchemaJson",
        );
      }
    },
  );
});
