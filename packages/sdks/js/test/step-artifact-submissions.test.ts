import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { artifact } from "../src/definitions/artifacts";
import {
  applyArtifactSubmissions,
  checkReturnedArtifactPaths,
  checkSubmittedArtifactFiles,
  findSubmittableArtifactFields,
  readStepArtifactSubmissions,
  writeStepArtifactSubmissions,
  type StepArtifactSubmissions,
} from "../src/contracts/step-artifact-submissions";

const schema = z.toJSONSchema(
  z.object({
    report: z.string(),
    reproVideo: artifact({ accept: [".webm"] }).nullable(),
    details: z
      .object({ screenshot: artifact({ accept: [".png"] }) })
      .optional(),
    shots: z.array(artifact()),
  }),
);
const fields = findSubmittableArtifactFields(schema);

const submitted = (stored: string) => ({
  stored,
  sourcePath: `/tmp/${stored}`,
  sizeBytes: 3,
});

describe("findSubmittableArtifactFields", () => {
  test.concurrent("skips fields inside arrays", () => {
    expect(fields.map((field) => field.path)).toEqual([
      "reproVideo",
      "details.screenshot",
    ]);
  });
});

describe("applyArtifactSubmissions — fill", () => {
  test.concurrent("fills stored names, nulls and nested parents", () => {
    const result = applyArtifactSubmissions({
      findings: { report: "r", shots: [] },
      fields,
      submissions: {
        fields: { "details.screenshot": submitted("details.screenshot.png") },
        extra: [],
      },
      mode: "fill",
    });
    expect(result).toEqual({
      findings: {
        report: "r",
        shots: [],
        reproVideo: null,
        details: { screenshot: "details.screenshot.png" },
      },
      problems: [],
    });
  });

  test.concurrent(
    "reports agent-written values and missing required fields",
    () => {
      const input = { report: "r", reproVideo: "/tmp/x.webm" };
      const result = applyArtifactSubmissions({
        findings: input,
        fields,
        submissions: { fields: {}, extra: [] },
        mode: "fill",
      });
      expect(result.problems).toEqual([
        '`reproVideo` is filled in from submitted artifacts. Remove it and call `boboddy-submit-artifact` with `field: "reproVideo"`.',
        '`details.screenshot` is required. Save the file and call `boboddy-submit-artifact` with `field: "details.screenshot"` first.',
      ]);
      expect(input.reproVideo).toBe("/tmp/x.webm");
    },
  );
});

describe("applyArtifactSubmissions — verify", () => {
  const submissions: StepArtifactSubmissions = {
    fields: {
      reproVideo: submitted("reproVideo.webm"),
      "details.screenshot": submitted("details.screenshot.png"),
    },
    extra: [],
  };

  test.concurrent("accepts findings that match the submissions", () => {
    const findings = {
      report: "r",
      reproVideo: "reproVideo.webm",
      details: { screenshot: "details.screenshot.png" },
    };
    expect(
      applyArtifactSubmissions({
        findings,
        fields,
        submissions,
        mode: "verify",
      }),
    ).toEqual({ findings, problems: [] });
  });

  test.concurrent("reports values that differ from the submissions", () => {
    const result = applyArtifactSubmissions({
      findings: { report: "r", reproVideo: "other.webm" },
      fields,
      submissions,
      mode: "verify",
    });
    expect(result.problems).toEqual([
      '`reproVideo` is "other.webm" in the findings, but the submitted artifacts record "reproVideo.webm".',
      '`details.screenshot` is null in the findings, but the submitted artifacts record "details.screenshot.png".',
    ]);
  });
});

describe("artifacts.json on disk", () => {
  test.concurrent("round-trips and checks stored files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "boboddy-artifacts-"));
    expect(await readStepArtifactSubmissions(workspace)).toEqual({
      fields: {},
      extra: [],
    });

    const submissions: StepArtifactSubmissions = {
      fields: {
        reproVideo: submitted("reproVideo.webm"),
        "details.screenshot": submitted("details.screenshot.png"),
      },
      extra: [],
    };
    await writeStepArtifactSubmissions(workspace, submissions);
    expect(await readStepArtifactSubmissions(workspace)).toEqual(submissions);

    await writeFile(
      join(workspace, ".boboddy/current-execution/artifacts.json"),
      JSON.stringify({ fields: { bad: { stored: 1 } }, extra: [] }),
    );
    expect(readStepArtifactSubmissions(workspace)).rejects.toThrow(
      ".boboddy/current-execution/artifacts.json is malformed",
    );
    await writeStepArtifactSubmissions(workspace, submissions);

    await mkdir(join(workspace, ".boboddy/step-artifacts"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".boboddy/step-artifacts/reproVideo.webm"),
      "vid",
    );
    expect(
      await checkSubmittedArtifactFiles({
        workspacePath: workspace,
        fields,
        submissions,
      }),
    ).toEqual([
      '`details.screenshot` was submitted as details.screenshot.png, but .boboddy/step-artifacts/details.screenshot.png is missing or empty. Save the file again and call `boboddy-submit-artifact` with `field: "details.screenshot"`.',
    ]);
  });
});

describe("checkReturnedArtifactPaths", () => {
  test.concurrent(
    "accepts files inside the folder and rejects escapes, missing files and wrong extensions",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "boboddy-returned-"));
      await mkdir(join(workspace, ".boboddy/step-artifacts/details"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, ".boboddy/step-artifacts/details/shot.png"),
        "png",
      );

      expect(
        await checkReturnedArtifactPaths({
          workspacePath: workspace,
          fields,
          findings: {
            reproVideo: null,
            details: { screenshot: "details/shot.png" },
          },
        }),
      ).toEqual([]);

      expect(
        await checkReturnedArtifactPaths({
          workspacePath: workspace,
          fields,
          findings: {
            reproVideo: "/abs/clip.webm",
            details: { screenshot: "details/shot.jpg" },
          },
        }),
      ).toEqual([
        '`reproVideo` must be a path relative to .boboddy/step-artifacts (use `Artifact.path("<name>")`), got "/abs/clip.webm".',
        "`details.screenshot` is details/shot.jpg, but .boboddy/step-artifacts/details/shot.jpg is missing or empty.",
      ]);

      await writeFile(
        join(workspace, ".boboddy/step-artifacts/clip.mp4"),
        "mp4",
      );
      expect(
        await checkReturnedArtifactPaths({
          workspacePath: workspace,
          fields,
          findings: {
            reproVideo: "clip.mp4",
            details: { screenshot: "./x.png" },
          },
        }),
      ).toEqual([
        "`reproVideo` accepts .webm, but clip.mp4 has .mp4.",
        '`details.screenshot` must be a path relative to .boboddy/step-artifacts (use `Artifact.path("<name>")`), got "./x.png".',
      ]);
    },
  );
});
