import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RemoteArtifactStore } from "../../../../src/artifacts/artifact-store/infra/remote-artifact-store";
import type { RemoteArtifactUploader } from "../../../../src/work/step-execution/contracts/process-project-work-types";

type CreateArgs = Parameters<RemoteArtifactUploader["createArtifactUploadUrl"]>[0];
type RecordArgs = Parameters<RemoteArtifactUploader["recordArtifact"]>[0];

// Records the control-plane calls the store makes and returns a canned upload
// URL so the PUT step has something to hit.
const recordingUploader = (
  uploadUrl = "https://store.test/upload",
): {
  uploader: RemoteArtifactUploader;
  createCalls: CreateArgs[];
  recordCalls: RecordArgs[];
} => {
  const createCalls: CreateArgs[] = [];
  const recordCalls: RecordArgs[] = [];
  return {
    createCalls,
    recordCalls,
    uploader: {
      createArtifactUploadUrl: (input: CreateArgs) => {
        createCalls.push(input);
        return Promise.resolve({
          uploadUrl,
          storeRef: "s3://bucket/derived-key",
          objectKey: "derived-key",
          expiresInSeconds: 900,
        });
      },
      recordArtifact: (input: RecordArgs) => {
        recordCalls.push(input);
        return Promise.resolve();
      },
    },
  };
};

describe("RemoteArtifactStore", () => {
  const previousFetch = globalThis.fetch;
  let dir: string;
  let sourceFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "remote-artifact-store-"));
    sourceFile = path.join(dir, "report.json");
    await writeFile(sourceFile, '{"ok":true}');
  });

  afterEach(async () => {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("mints a URL, PUTs the bytes, records the artifact, and returns the ref", async () => {
    const { uploader, createCalls, recordCalls } = recordingUploader();
    const fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;

    const store = new RemoteArtifactStore(uploader);
    const result = await store.saveArtifact({
      stepExecutionId: "step-1",
      sourcePath: sourceFile,
      relativeStorePath: "reports/report.json",
      claimToken: "claim-1",
      kind: "generic",
    });

    // createArtifactUploadUrl called with the derived args + detected content
    // type + the real byte size (read before the URL is requested), so the
    // API's upload-cap pre-flight can check storage headroom, not just the
    // write-count cap.
    const expectedSizeBytes = '{"ok":true}'.length;
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      stepExecutionId: "step-1",
      claimToken: "claim-1",
      relativeStorePath: "reports/report.json",
      contentType: "application/json",
      sizeBytes: expectedSizeBytes,
    });

    // PUT to the minted URL with the file bytes and matching content type.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://store.test/upload");
    expect(fetchCalls[0]?.init?.method).toBe("PUT");
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");

    // recordArtifact called with the object key + real byte size.
    const sizeBytes = '{"ok":true}'.length;
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({
      stepExecutionId: "step-1",
      claimToken: "claim-1",
      objectKey: "derived-key",
      relativeStorePath: "reports/report.json",
      sizeBytes,
      contentType: "application/json",
      kind: "generic",
    });

    expect(result).toEqual({ storeRef: "s3://bucket/derived-key", sizeBytes });
  });

  test("forwards the artifact kind through to recordArtifact", async () => {
    const { uploader, recordCalls } = recordingUploader();
    globalThis.fetch = (() =>
      Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;

    const store = new RemoteArtifactStore(uploader);
    const tracePath = path.join(dir, "trace.zip");
    await writeFile(tracePath, "trace-bytes");
    await store.saveArtifact({
      stepExecutionId: "step-1",
      sourcePath: tracePath,
      relativeStorePath: "test-results/example/trace.zip",
      claimToken: "claim-1",
      kind: "playwright-trace",
    });

    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]?.kind).toBe("playwright-trace");
  });

  test("throws when no claimToken is supplied", async () => {
    const { uploader, createCalls } = recordingUploader();
    const store = new RemoteArtifactStore(uploader);

    let caught: unknown;
    try {
      await store.saveArtifact({
        stepExecutionId: "step-1",
        sourcePath: sourceFile,
        relativeStorePath: "reports/report.json",
        kind: "generic",
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.message).toMatch(/requires a claimToken/i);
    // Fails before touching the control plane.
    expect(createCalls).toHaveLength(0);
  });

  test("throws with the HTTP status when the upload PUT is not ok", async () => {
    const { uploader, recordCalls } = recordingUploader();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("access denied", { status: 403, statusText: "Forbidden" }),
      )) as unknown as typeof fetch;

    const store = new RemoteArtifactStore(uploader);
    let caught: unknown;
    try {
      await store.saveArtifact({
        stepExecutionId: "step-1",
        sourcePath: sourceFile,
        relativeStorePath: "reports/report.json",
        claimToken: "claim-1",
        kind: "generic",
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.message).toMatch(/403/);
    // Never records an artifact whose upload failed.
    expect(recordCalls).toHaveLength(0);
  });

  test("detects content types from file extensions", async () => {
    const cases: { file: string; relative: string; expected: string }[] = [
      { file: "notes.md", relative: "notes.md", expected: "text/markdown" },
      { file: "image.png", relative: "image.png", expected: "image/png" },
      { file: "blob.bin", relative: "blob.bin", expected: "application/octet-stream" },
    ];

    for (const { file, relative, expected } of cases) {
      const filePath = path.join(dir, file);
      await writeFile(filePath, "x");
      const { uploader, createCalls } = recordingUploader();
      globalThis.fetch = (() =>
        Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;

      const store = new RemoteArtifactStore(uploader);
      await store.saveArtifact({
        stepExecutionId: "step-1",
        sourcePath: filePath,
        relativeStorePath: relative,
        claimToken: "claim-1",
        kind: "generic",
      });

      expect(createCalls[0]?.contentType).toBe(expected);
    }
  });
});
