import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildSubmitArtifactDescription,
  createBoboddySubmitArtifactTool,
  submitArtifact,
} from "./boboddy-submit-artifact";

const RESULT_SCHEMA = {
  type: "object",
  required: ["report", "reproVideo", "screenshot"],
  additionalProperties: false,
  properties: {
    report: { type: "string" },
    reproVideo: {
      anyOf: [
        {
          type: "string",
          "x-boboddy-artifact": { accept: [".mp4", ".webm", ".mov", ".gif"] },
        },
        { type: "null" },
      ],
      description: "Screen recording of the failure",
    },
    screenshot: {
      type: "string",
      "x-boboddy-artifact": { accept: [".png"] },
    },
  },
};

async function createWorkspace(
  resultSchemaJson: Record<string, unknown> | null = RESULT_SCHEMA,
): Promise<string> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "boboddy-submit-artifact-"),
  );
  await mkdir(path.join(workspacePath, ".boboddy/current-execution"), {
    recursive: true,
  });
  await writeFile(
    path.join(workspacePath, ".boboddy/current-execution/execution.json"),
    JSON.stringify({ taskId: "task-id", resultSchemaJson }),
  );
  return workspacePath;
}

async function writeSource(
  workspacePath: string,
  relativePath: string,
  content = "bytes",
): Promise<string> {
  const filePath = path.join(workspacePath, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

async function readSubmissions(workspacePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(workspacePath, ".boboddy/current-execution/artifacts.json"),
      "utf8",
    ),
  );
}

function expectRejection(
  promise: Promise<object>,
  ...fragments: string[]
): void {
  for (const fragment of fragments) {
    expect(promise).rejects.toThrow(fragment);
  }
}

describe("buildSubmitArtifactDescription", () => {
  test("lists each declared field", () => {
    expect(buildSubmitArtifactDescription(RESULT_SCHEMA)).toMatchSnapshot();
  });

  test.concurrent(
    "falls back to a generic description without a schema",
    () => {
      expect(buildSubmitArtifactDescription(undefined)).toContain(
        "If the step declares artifact fields",
      );
      expect(buildSubmitArtifactDescription(null)).toContain(
        "declares no artifact fields",
      );
    },
  );
});

describe("createBoboddySubmitArtifactTool", () => {
  test.concurrent("builds its description from execution.json", async () => {
    const workspacePath = await createWorkspace();
    const tool = await createBoboddySubmitArtifactTool(workspacePath);
    expect(tool.description).toContain(
      "- reproVideo (.mp4, .webm, .mov, .gif; optional): Screen recording of the failure",
    );
  });

  test.concurrent(
    "uses the generic description when execution.json is missing",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-submit-artifact-"),
      );
      const tool = await createBoboddySubmitArtifactTool(workspacePath);
      expect(tool.description).toBe(buildSubmitArtifactDescription(undefined));
    },
  );
});

describe("submitArtifact", () => {
  test.concurrent(
    "copies a declared field to <field>.<ext> and records it",
    async () => {
      const workspacePath = await createWorkspace();
      const source = await writeSource(workspacePath, "tmp/video-3f2a.webm");

      const result = await submitArtifact(
        { path: source, field: "reproVideo" },
        workspacePath,
      );

      expect(result).toEqual({
        ok: true,
        field: "reproVideo",
        stored: "reproVideo.webm",
        warnings: [],
      });
      expect(
        await readFile(
          path.join(workspacePath, ".boboddy/step-artifacts/reproVideo.webm"),
          "utf8",
        ),
      ).toBe("bytes");
      expect(await readFile(source, "utf8")).toBe("bytes");
      expect(await readSubmissions(workspacePath)).toEqual({
        fields: {
          reproVideo: {
            stored: "reproVideo.webm",
            sourcePath: source,
            sizeBytes: 5,
          },
        },
        extra: [],
      });
    },
  );

  test.concurrent(
    "replaces an earlier submission of the same field",
    async () => {
      const workspacePath = await createWorkspace();
      await writeSource(workspacePath, "first.mp4");
      await writeSource(workspacePath, "second.webm", "retry");

      await submitArtifact(
        { path: "first.mp4", field: "reproVideo" },
        workspacePath,
      );
      const result = await submitArtifact(
        { path: "second.webm", field: "reproVideo" },
        workspacePath,
      );

      expect(result.warnings).toEqual([
        "Replaced the earlier submission for `reproVideo` (reproVideo.mp4).",
      ]);
      expect(
        await Bun.file(
          path.join(workspacePath, ".boboddy/step-artifacts/reproVideo.mp4"),
        ).exists(),
      ).toBe(false);
      expect(await readSubmissions(workspacePath)).toMatchObject({
        fields: {
          reproVideo: { stored: "reproVideo.webm", sourcePath: "second.webm" },
        },
      });
    },
  );

  test.concurrent(
    "stores undeclared files under their basename or name",
    async () => {
      const workspacePath = await createWorkspace();
      await writeSource(workspacePath, "out/trace.zip");
      await writeSource(workspacePath, "banner.png");

      const byBasename = await submitArtifact(
        { path: "out/trace.zip" },
        workspacePath,
      );
      const byName = await submitArtifact(
        { path: "banner.png", name: "screens/banner.png" },
        workspacePath,
      );

      expect(byBasename).toEqual({
        ok: true,
        field: null,
        stored: "trace.zip",
        warnings: [
          "No platform embeds .zip files, so trace.zip will be linked rather than embedded in comments.",
        ],
      });
      expect(byName).toEqual({
        ok: true,
        field: null,
        stored: "screens/banner.png",
        warnings: [],
      });
      expect(await readSubmissions(workspacePath)).toEqual({
        fields: {},
        extra: [
          { stored: "trace.zip", sourcePath: "out/trace.zip", sizeBytes: 5 },
          {
            stored: "screens/banner.png",
            sourcePath: "banner.png",
            sizeBytes: 5,
          },
        ],
      });
    },
  );

  test.concurrent(
    "rejects a name that escapes the artifacts folder",
    async () => {
      const workspacePath = await createWorkspace();
      await writeSource(workspacePath, "banner.png");

      for (const name of [
        "../banner.png",
        "/etc/banner.png",
        "a/../../b.png",
      ]) {
        expectRejection(
          submitArtifact({ path: "banner.png", name }, workspacePath),
          "`name` must be a file path inside .boboddy/step-artifacts",
        );
      }
    },
  );

  test.concurrent(
    "lists the declared fields for an unknown field",
    async () => {
      const workspacePath = await createWorkspace();
      await writeSource(workspacePath, "clip.mp4");

      expectRejection(
        submitArtifact({ path: "clip.mp4", field: "video" }, workspacePath),
        "`video` is not a declared artifact field.",
        "reproVideo (.mp4, .webm, .mov, .gif; optional): Screen recording of the failure",
        "screenshot (.png; required)",
      );
    },
  );

  test.concurrent("rejects a missing, non-regular or empty file", async () => {
    const workspacePath = await createWorkspace();
    await writeSource(workspacePath, "empty.png", "");
    await mkdir(path.join(workspacePath, "dir.png"));

    expectRejection(
      submitArtifact({ path: "nope.png", field: "screenshot" }, workspacePath),
      "File not found",
    );
    expectRejection(
      submitArtifact({ path: "dir.png", field: "screenshot" }, workspacePath),
      "Not a regular file",
    );
    expectRejection(
      submitArtifact({ path: "empty.png", field: "screenshot" }, workspacePath),
      "File is empty",
    );
  });

  test.concurrent("rejects an extension the field doesn't accept", async () => {
    const workspacePath = await createWorkspace();
    await writeSource(workspacePath, "clip.mkv");

    expectRejection(
      submitArtifact({ path: "clip.mkv", field: "reproVideo" }, workspacePath),
      "`reproVideo` accepts .mp4, .webm, .mov, .gif, but clip.mkv has .mkv.",
      "Screen recording of the failure",
    );
  });

  test.concurrent(
    "warns that an accepted but non-embeddable file will be linked",
    async () => {
      const workspacePath = await createWorkspace();
      await writeSource(workspacePath, "clip.mov");

      const result = await submitArtifact(
        { path: "clip.mov", field: "reproVideo" },
        workspacePath,
      );

      expect(result.warnings).toEqual([
        "No platform embeds .mov files, so reproVideo.mov will be linked rather than embedded in comments.",
      ]);
    },
  );

  test.concurrent(
    "explains a field can't be checked without execution.json",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "boboddy-submit-artifact-"),
      );
      await writeSource(workspacePath, "clip.mp4");

      expectRejection(
        submitArtifact(
          { path: "clip.mp4", field: "reproVideo" },
          workspacePath,
        ),
        "could not be read",
      );
    },
  );
});
