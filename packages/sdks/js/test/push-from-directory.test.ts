import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushFromDirectory } from "../src/push/push-from-directory";

type CapturedRequest = {
  url: string;
  method: string;
  body: unknown;
};

async function readRequest(input: string | URL | Request): Promise<CapturedRequest> {
  const req = input as Request;
  const text = await req.clone().text();
  return {
    url: req.url,
    method: req.method,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
}

const BASE_URL = "https://boboddy.example.com";

/**
 * Mock fetch that remembers which step definitions have been upserted. On
 * subsequent GETs to `/api/step-definitions`, it returns those upserts so the
 * pipeline-upsert code can resolve `stepDefinitionId` references.
 */
function makeMockFetch(captured: CapturedRequest[]): typeof globalThis.fetch {
  const upsertedSteps: Array<{ id: string; key: string; version: number }> = [];
  let nextId = 1;
  return (async (input: string | URL | Request) => {
    const req = await readRequest(input);
    captured.push(req);

    if (req.method === "GET" && req.url.includes("/api/step-definitions")) {
      return new Response(JSON.stringify(upsertedSteps), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.method === "GET") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.method === "PUT" && req.url.endsWith("/api/step-definitions")) {
      const body = req.body as { key: string; version: number };
      const id = `step-${String(nextId++)}`;
      upsertedSteps.push({ id, key: body.key, version: body.version });
      return new Response(JSON.stringify({ id, key: body.key, version: body.version }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "x" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

const PIPELINE_SPEC_JS = (key: string) => `
export default {
  key: ${JSON.stringify(key)},
  name: ${JSON.stringify(key)},
  description: null,
  version: 1,
  status: "active",
  steps: [
    {
      stepKey: "step-a",
      stepName: "Step A",
      stepDescription: null,
      position: 0,
      inputBindingsJson: {},
      timeoutSeconds: null,
      advancementPolicyDefinition: {
        rulesJson: { rules: [] },
        defaultEventType: "continue",
        defaultEventParamsJson: null,
        allowedEventTypes: ["continue"],
      },
      computedSignalDefinitions: [],
    },
  ],
  _stepDefinitions: [{
    key: "step-a",
    name: "Step A",
    description: null,
    version: 1,
    kind: "user_defined",
    status: "active",
    prompt: null,
    inputSchemaJson: null,
    resultSchemaJson: null,
    signalExtractorDefinitions: [],
    opencodeMcpJson: null,
  }],
};
`;

describe("pushFromDirectory", () => {
  const previousFetch = globalThis.fetch;
  let dir: string;
  const captured: CapturedRequest[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "boboddy-pfd-test-"));
    writeFileSync(join(dir, "investigation.js"), PIPELINE_SPEC_JS("investigation"));

    globalThis.fetch = makeMockFetch(captured);
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test("upserts steps and pipelines discovered in the directory", async () => {
    const result = await pushFromDirectory(dir, {
      baseUrl: BASE_URL,
      projectId: "proj-1",
      accessToken: "abc123",
      log: () => undefined,
    });

    expect(result.pushedSteps).toBe(1);
    expect(result.pushedPipelines).toBe(1);

    const stepUpsert = captured.find(
      (r) => r.method === "PUT" && r.url.endsWith("/api/step-definitions"),
    );
    expect(stepUpsert).toBeDefined();
    expect(stepUpsert!.body).toMatchObject({
      projectId: "proj-1",
      key: "step-a",
      version: 1,
    });

    const pipelineUpsert = captured.find(
      (r) =>
        r.method === "PUT" &&
        r.url.endsWith("/api/linear-pipeline-definitions"),
    );
    expect(pipelineUpsert).toBeDefined();
    expect(pipelineUpsert!.body).toMatchObject({
      projectId: "proj-1",
      key: "investigation",
      status: "active",
    });
  });

  test("skips push.ts even when present", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "boboddy-pfd-skip-"));
    const previous2 = globalThis.fetch;
    globalThis.fetch = makeMockFetch([]);
    try {
      writeFileSync(join(dir2, "push.ts"), `throw new Error("should not be loaded");`);
      writeFileSync(join(dir2, "investigation.js"), PIPELINE_SPEC_JS("investigation-2"));
      const result = await pushFromDirectory(dir2, {
        baseUrl: BASE_URL,
        projectId: "proj-2",
        accessToken: "tok",
        log: () => undefined,
      });
      expect(result.pushedPipelines).toBe(1);
    } finally {
      globalThis.fetch = previous2;
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("pushFromDirectory route validation", () => {
  const previousFetch = globalThis.fetch;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "boboddy-pfd-route-"));
    mkdirSync(dir, { recursive: true });

    // Pipeline that routes to a non-existent target.
    const PIPELINE = `
      export default {
        key: "router",
        name: "Router",
        description: null,
        version: 1,
        status: "active",
        steps: [
          {
            stepKey: "step-a",
            stepName: "Step A",
            stepDescription: null,
            position: 0,
            inputBindingsJson: {},
            timeoutSeconds: null,
            advancementPolicyDefinition: {
              rulesJson: { rules: [] },
              defaultEventType: "route",
              defaultEventParamsJson: { pipelineKey: "missing-target" },
              allowedEventTypes: ["route", "continue"],
            },
            computedSignalDefinitions: [],
          },
        ],
        _stepDefinitions: [{
          key: "step-a",
          name: "Step A",
          description: null,
          version: 1,
          kind: "user_defined",
          status: "active",
          prompt: null,
          inputSchemaJson: null,
          resultSchemaJson: null,
          signalExtractorDefinitions: [],
          opencodeMcpJson: null,
        }],
      };
    `;
    writeFileSync(join(dir, "router.js"), PIPELINE);

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when a step routes to a pipeline that doesn't exist locally or on the server", async () => {
    let caught: unknown;
    try {
      await pushFromDirectory(dir, {
        baseUrl: BASE_URL,
        projectId: "proj-3",
        accessToken: "tok",
        log: () => undefined,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      'routes to pipeline "missing-target"',
    );
  });
});
