import { describe, expect, test } from "bun:test";
import { detectArtifactKind } from "../../../../src/artifacts/artifact-store/domain/detect-artifact-kind";

describe("detectArtifactKind", () => {
  test.each([
    ["trace.zip", "playwright-trace"],
    ["test-results/foo/trace.zip", "playwright-trace"],
    ["test-results/foo-chromium/trace.zip", "playwright-trace"],
    ["some/nested/trace.zip", "playwright-trace"],
    ["report.html", "generic"],
    ["screenshot.png", "generic"],
    ["traces/other.zip", "generic"],
    ["", "generic"],
  ] as const)("classifies %p as %p", (relativeStorePath, expected) => {
    expect(detectArtifactKind(relativeStorePath)).toBe(expected);
  });
});
