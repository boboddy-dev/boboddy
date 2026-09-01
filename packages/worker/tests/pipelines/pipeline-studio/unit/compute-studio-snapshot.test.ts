import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStudioSnapshot } from "../../../../src/pipelines/pipeline-studio/application/compute-studio-snapshot";

/**
 * Fixture pipeline definitions are written as plain object-literal exports,
 * not `definePipeline({...})` calls — `collectDefinitionsFromDirectory` only
 * checks the SPEC's shape (see its `isPipelineDefinitionSpec`), so this
 * avoids the bare-specifier resolution problem a temp directory has no
 * `node_modules/@boboddy/sdk` to satisfy (the same reason
 * `packages/sdks/js/test/collect-definitions.test.ts` writes relative
 * import paths for the one case — code steps — that genuinely needs a real
 * SDK import).
 */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "boboddy-studio-snapshot-test-"));
}

const VALID_PIPELINE = `export default {
  key: "review-pr",
  name: "Review PR",
  description: null,
  version: 1,
  status: "active",
  nodeDefinitions: [
    { nodeKey: "analyze", kind: "step", stepKey: "analyze-step", stepName: "Analyze" },
    { nodeKey: "done", kind: "succeed" },
  ],
  dependencyEdges: [{ fromNodeKey: "analyze", toNodeKey: "done" }],
};
`;

const PIPELINE_WITH_BAD_ROUTE = `export default {
  key: "review-pr",
  name: "Review PR",
  description: null,
  version: 1,
  status: "active",
  nodeDefinitions: [
    {
      nodeKey: "route",
      kind: "step",
      stepKey: "route-step",
      stepName: "Route",
      advancementPolicyDefinition: {
        defaultEventType: "route",
        defaultEventParamsJson: { pipelineKey: "missing-pipeline" },
        rulesJson: { rules: [] },
      },
    },
  ],
  dependencyEdges: [],
};
`;

describe("computeStudioSnapshot", () => {
  test("collects, validates, and translates every pipeline in the directory", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "review-pr.ts"), VALID_PIPELINE);

      const snapshot = await computeStudioSnapshot(dir);

      expect(snapshot.status).toBe("ok");
      if (snapshot.status !== "ok") return;
      expect(snapshot.pipelines).toHaveLength(1);
      expect(snapshot.pipelines[0]?.key).toBe("review-pr");
      expect(snapshot.pipelines[0]?.nodes).toHaveLength(2);
      expect(snapshot.pipelines[0]?.edges).toHaveLength(1);
      expect(snapshot.validationIssues).toEqual([]);
      expect(snapshot.brokenPipelines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("surfaces a route-target issue both on the node and in the full list", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "review-pr.ts"), PIPELINE_WITH_BAD_ROUTE);

      const snapshot = await computeStudioSnapshot(dir);

      expect(snapshot.status).toBe("ok");
      if (snapshot.status !== "ok") return;
      expect(snapshot.validationIssues).toHaveLength(1);
      expect(snapshot.validationIssues[0]?.check).toBe("route-target");

      const routeNode = snapshot.pipelines[0]?.nodes.find(
        (n) => n.id === "route",
      );
      expect(routeNode?.data.issues).toHaveLength(1);
      expect(routeNode?.data.issues[0]?.check).toBe("route-target");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isolates one broken file into brokenPipelines instead of blanking the snapshot", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "review-pr.ts"), VALID_PIPELINE);
      writeFileSync(
        join(dir, "broken.ts"),
        `throw new Error("syntax problem, deliberately");\n`,
      );

      const snapshot = await computeStudioSnapshot(dir);

      expect(snapshot.status).toBe("ok");
      if (snapshot.status !== "ok") return;
      // The good pipeline still renders fully...
      expect(snapshot.pipelines).toHaveLength(1);
      expect(snapshot.pipelines[0]?.key).toBe("review-pr");
      // ...and the broken file is reported separately, not thrown away.
      expect(snapshot.brokenPipelines).toHaveLength(1);
      expect(snapshot.brokenPipelines[0]?.key).toBe("broken");
      expect(snapshot.brokenPipelines[0]?.message).toContain(
        "syntax problem, deliberately",
      );
      expect(snapshot.collectedAt).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty directory is a clean, empty snapshot", async () => {
    const dir = makeTempDir();
    try {
      const snapshot = await computeStudioSnapshot(dir);

      expect(snapshot).toMatchObject({
        status: "ok",
        pipelines: [],
        brokenPipelines: [],
        validationIssues: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
