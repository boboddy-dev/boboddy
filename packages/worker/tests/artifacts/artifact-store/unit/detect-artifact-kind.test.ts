import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { detectArtifactKind } from "../../../../src/artifacts/artifact-store/domain/detect-artifact-kind";
import { buildTestZip } from "../../../support/build-test-zip";

async function writeTempFile(
  name: string,
  content: Buffer | string,
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "detect-artifact-kind-"));
  const filePath = path.join(dir, name);
  await writeFile(filePath, content);
  return filePath;
}

describe("detectArtifactKind", () => {
  test("classifies non-zip files as generic without opening them", async () => {
    const filePath = await writeTempFile("report.html", "<html></html>");
    expect(await detectArtifactKind("report.html", filePath)).toBe("generic");
  });

  test("classifies a .zip with no trace entry as generic", async () => {
    const zip = buildTestZip(["report.html", "screenshot.png"]);
    const filePath = await writeTempFile("bundle.zip", zip);
    expect(await detectArtifactKind("bundle.zip", filePath)).toBe("generic");
  });

  test("classifies a .zip containing trace.trace as playwright-trace, regardless of the zip's own filename", async () => {
    const zip = buildTestZip([
      "trace.trace",
      "trace.network",
      "trace.stacks",
      "resources/abc123",
    ]);
    const filePath = await writeTempFile("reproduce-in-browser-trace.zip", zip);
    expect(
      await detectArtifactKind("reproduce-in-browser-trace.zip", filePath),
    ).toBe("playwright-trace");
  });

  test("classifies a .zip nested under any directory as playwright-trace when it contains a *.trace entry", async () => {
    const zip = buildTestZip(["trace.trace", "trace.network"]);
    const filePath = await writeTempFile("trace.zip", zip);
    expect(await detectArtifactKind("some/nested/trace.zip", filePath)).toBe(
      "playwright-trace",
    );
  });

  test("classifies @playwright/test's multi-context trace naming (test.trace, 0-trace.trace) as playwright-trace", async () => {
    const zip = buildTestZip([
      "test.trace",
      "0-trace.trace",
      "0-trace.network",
      "1-trace.trace",
      "1-trace.stacks",
    ]);
    const filePath = await writeTempFile("trace.zip", zip);
    expect(await detectArtifactKind("trace.zip", filePath)).toBe(
      "playwright-trace",
    );
  });

  test("classifies a directory merely named 'traces' containing an unrelated zip as generic", async () => {
    const zip = buildTestZip(["other.txt"]);
    const filePath = await writeTempFile("other.zip", zip);
    expect(await detectArtifactKind("traces/other.zip", filePath)).toBe(
      "generic",
    );
  });

  test("does not misclassify a .zip whose filename merely contains the substring 'trace' but has no *.trace entry", async () => {
    const zip = buildTestZip(["readme.txt"]);
    const filePath = await writeTempFile("my-trace-bundle.zip", zip);
    expect(await detectArtifactKind("my-trace-bundle.zip", filePath)).toBe(
      "generic",
    );
  });

  test("fails closed (generic) for a .zip-named file that isn't actually a valid zip", async () => {
    const filePath = await writeTempFile("trace.zip", "not actually a zip");
    expect(await detectArtifactKind("trace.zip", filePath)).toBe("generic");
  });

  test("classifies an empty relative path as generic", async () => {
    const filePath = await writeTempFile("empty.txt", "");
    expect(await detectArtifactKind("", filePath)).toBe("generic");
  });
});
