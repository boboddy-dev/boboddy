import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipelineStudioServer } from "../../../../src/pipelines/pipeline-studio/application/run-pipeline-studio-server";
import type { StudioSnapshot } from "@boboddy/pipeline-studio-ui";

/**
 * A real `Bun.serve` + real `fs.watch` smoke test — deliberately NOT a fake,
 * unlike `apps/cli`'s command-wiring tests (see the phase report): this is
 * the one place that mechanism itself is exercised end to end. Static-asset
 * serving is intentionally left untested here — it depends on
 * `packages/pipeline-studio-ui`'s build output existing on disk, which this
 * test suite should not require as a precondition (see that package's own
 * `build.ts` for how those assets are produced).
 */

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "boboddy-studio-server-test-"));
}

const PIPELINE_V1 = `export default {
  key: "review-pr", name: "Review PR", description: null, version: 1, status: "active",
  nodeDefinitions: [{ nodeKey: "analyze", kind: "step", stepKey: "analyze-step", stepName: "Analyze" }],
  dependencyEdges: [],
};
`;

const PIPELINE_V2 = `export default {
  key: "review-pr", name: "Review PR", description: null, version: 1, status: "active",
  nodeDefinitions: [
    { nodeKey: "analyze", kind: "step", stepKey: "analyze-step", stepName: "Analyze" },
    { nodeKey: "done", kind: "succeed" },
  ],
  dependencyEdges: [{ fromNodeKey: "analyze", toNodeKey: "done" }],
};
`;

/** Reads one `data: {...}\n\n` SSE frame from a stream reader. */
async function readOneSnapshot(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<StudioSnapshot> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Stream closed before a full SSE frame arrived");
    buffer += decoder.decode(value, { stream: true });
    const frameEnd = buffer.indexOf("\n\n");
    if (frameEnd === -1) continue;
    const frame = buffer.slice(0, frameEnd);
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error(`Malformed SSE frame: ${frame}`);
    return JSON.parse(dataLine.slice("data: ".length)) as StudioSnapshot;
  }
}

describe("runPipelineStudioServer", () => {
  test("streams an initial snapshot, then a fresh one after a file change", async () => {
    const dir = makeTempDir();
    const handle = await runPipelineStudioServer({ builderDir: dir });
    try {
      writeFileSync(join(dir, "review-pr.ts"), PIPELINE_V1);
      // The handle's own preflight snapshot predates this write, so the
      // FIRST stream connection is what actually observes it.
      const response = await fetch(`${handle.url}/api/stream`);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a readable SSE body");

      const initial = await readOneSnapshot(reader);
      expect(initial.status).toBe("ok");

      writeFileSync(join(dir, "review-pr.ts"), PIPELINE_V2);

      const updated = await readOneSnapshot(reader);
      expect(updated.status).toBe("ok");
      if (updated.status !== "ok") return;
      expect(updated.pipelines[0]?.nodes).toHaveLength(2);
      expect(updated.pipelines[0]?.edges).toHaveLength(1);

      await reader.cancel();
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test("close() stops accepting new connections", async () => {
    const dir = makeTempDir();
    const handle = await runPipelineStudioServer({ builderDir: dir });
    const url = handle.url;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });

    let failed = false;
    try {
      await fetch(`${url}/api/stream`);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
