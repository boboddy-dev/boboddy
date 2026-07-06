import type { ArtifactKind } from "@boboddy/sdk/contracts/artifacts";

/**
 * Classifies a collected artifact by its store-relative path. Playwright writes
 * traces as `trace.zip`, typically under a `test-results/` directory.
 */
export function detectArtifactKind(relativeStorePath: string): ArtifactKind {
  const normalized = relativeStorePath.toLowerCase();
  const base = normalized.split("/").pop() ?? "";
  const isTrace =
    base === "trace.zip" ||
    (/(^|\/)test-results\//.test(normalized) &&
      base.endsWith(".zip") &&
      base.includes("trace"));
  return isTrace ? "playwright-trace" : "generic";
}
