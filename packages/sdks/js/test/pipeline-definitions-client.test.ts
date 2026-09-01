import { describe, expect, test } from "bun:test";
import { createPipelineDefinitionsClient } from "../src/definitions/pipelines/pipeline-definitions-client";
import type { PipelineDefinitionSpec } from "../src/definitions/pipelines/define-pipeline";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

type MockResponse = { status: number; body: unknown };

async function readRequestDetails(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}> {
  if (input instanceof Request) {
    const text = await input.clone().text();
    return {
      url: input.url,
      method: input.method,
      headers: Object.fromEntries(input.headers.entries()),
      body: text.length > 0 ? JSON.parse(text) : undefined,
    };
  }
  const url = input instanceof URL ? input.toString() : input;
  const rawHeaders = init?.headers;
  const headers =
    rawHeaders instanceof Headers
      ? Object.fromEntries(rawHeaders.entries())
      : Object.fromEntries(
          Object.entries(
            (rawHeaders as Record<string, string> | undefined) ?? {},
          ),
        );
  const rawBody = init?.body;
  const body =
    typeof rawBody === "string" && rawBody.length > 0
      ? (JSON.parse(rawBody) as unknown)
      : undefined;
  return { url, method: init?.method ?? "GET", headers, body };
}

function createMockFetch(responses: MockResponse[]): {
  mockFetch: typeof globalThis.fetch;
  captured: CapturedRequest[];
} {
  let callIndex = 0;
  const captured: CapturedRequest[] = [];

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.push(await readRequestDetails(input, init));

    const resp = responses[callIndex++] ?? { status: 200, body: null };
    if (resp.body !== null && resp.body !== undefined) {
      return new Response(JSON.stringify(resp.body), {
        status: resp.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("", { status: resp.status });
  };

  return { mockFetch: mockFetch as typeof globalThis.fetch, captured };
}

const AUTH_HEADER = { Authorization: "Bearer test-token" };
const BASE_URL = "https://boboddy.example.com";

const ADVANCEMENT_POLICY = {
  rulesJson: { rules: [] },
  defaultEventType: "continue" as const,
  defaultEventParamsJson: null,
  allowedEventTypes: ["continue" as const],
};

function makeSpec(
  overrides?: Partial<PipelineDefinitionSpec>,
): PipelineDefinitionSpec {
  return {
    key: "investigation",
    name: "Investigation",
    description: null,
    version: 1,
    status: "active",
    nodeDefinitions: [
      {
        nodeKey: "investigate",
        kind: "step",
        stepKey: "investigate",
        stepName: "Investigate",
        stepDescription: null,
        inputBindingsJson: {},
        timeoutSeconds: null,
        advancementPolicyDefinition: ADVANCEMENT_POLICY,
        computedSignalDefinitions: [],
      },
    ],
    dependencyEdges: [],
    ...overrides,
  };
}

describe("createPipelineDefinitionsClient", () => {
  describe("listByProjectId", () => {
    test("sends GET to /api/projects/{projectId}/pipeline-definitions", async () => {
      const { mockFetch, captured } = createMockFetch([
        { status: 200, body: [] },
      ]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.listByProjectId("proj-1", { headers: AUTH_HEADER });

        expect(captured).toHaveLength(1);
        expect(captured[0]?.method).toBe("GET");
        expect(captured[0]?.url).toBe(
          `${BASE_URL}/api/projects/proj-1/pipeline-definitions`,
        );
        // Headers.entries() lowercases header names per the WHATWG spec.
        expect(captured[0]?.headers["authorization"]).toBe("Bearer test-token");
      } finally {
        globalThis.fetch = prev;
      }
    });

    test("returns empty array when the server responds with an empty list", async () => {
      const { mockFetch } = createMockFetch([{ status: 200, body: [] }]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        const result = await client.listByProjectId("proj-1", {
          headers: AUTH_HEADER,
        });
        expect(result).toEqual([]);
      } finally {
        globalThis.fetch = prev;
      }
    });
  });

  describe("upsertFromSpec", () => {
    test("sends PUT to /api/pipeline-definitions with the graph-shaped body", async () => {
      const { mockFetch, captured } = createMockFetch([
        { status: 200, body: { id: "pipeline-id" } },
      ]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.upsertFromSpec(
          "proj-1",
          makeSpec(),
          [{ id: "step-def-id", key: "investigate", version: 1 }],
          { headers: AUTH_HEADER },
        );

        expect(captured).toHaveLength(1);
        expect(captured[0]?.method).toBe("PUT");
        expect(captured[0]?.url).toBe(`${BASE_URL}/api/pipeline-definitions`);
        expect(captured[0]?.body).toMatchObject({
          projectId: "proj-1",
          key: "investigation",
          name: "Investigation",
          status: "active",
          nodeDefinitions: [
            {
              key: "investigate",
              kind: "step",
              stepDefinitionId: "step-def-id",
              stepDefinitionVersion: 1,
            },
          ],
          dependencyEdges: [],
        });
      } finally {
        globalThis.fetch = prev;
      }
    });

    test("picks the highest-version step def when multiple versions are present", async () => {
      const { mockFetch, captured } = createMockFetch([
        { status: 200, body: { id: "pipeline-id" } },
      ]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.upsertFromSpec(
          "proj-1",
          makeSpec(),
          [
            { id: "old-id", key: "investigate", version: 1 },
            { id: "new-id", key: "investigate", version: 2 },
          ],
          { headers: AUTH_HEADER },
        );

        const body = captured[0]?.body as {
          nodeDefinitions: Array<{
            stepDefinitionId: string;
            stepDefinitionVersion: number;
          }>;
        };
        expect(body.nodeDefinitions[0]).toMatchObject({
          stepDefinitionId: "new-id",
          stepDefinitionVersion: 2,
        });
      } finally {
        globalThis.fetch = prev;
      }
    });

    test("throws a descriptive error when a referenced step key is missing", async () => {
      const { mockFetch } = createMockFetch([
        { status: 200, body: { id: "pipeline-id" } },
      ]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;

      let caughtError: unknown;
      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.upsertFromSpec("proj-1", makeSpec(), [], {
          headers: AUTH_HEADER,
        });
      } catch (err) {
        caughtError = err;
      } finally {
        globalThis.fetch = prev;
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toContain(
        'Step "investigate" referenced by node "investigate" in pipeline "investigation" was not found',
      );
    });

    test("pushes a fanOut/cohortGate pair via the graph shape (no longer chain-only)", async () => {
      const { mockFetch, captured } = createMockFetch([
        { status: 200, body: { id: "pipeline-id" } },
      ]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;

      const spec = makeSpec({
        nodeDefinitions: [
          {
            nodeKey: "review",
            kind: "fanOut",
            stepKey: "review",
            stepName: "Review",
            stepDescription: null,
            inputBindingsJson: {},
            timeoutSeconds: null,
            overSignalKey: "reviewer_count",
            advanceEachPolicyDefinition: {
              rules: [],
              defaultEventType: "continue",
              defaultEventParamsJson: null,
            },
            maxConcurrency: null,
          },
          {
            nodeKey: "review__cohortGate",
            kind: "cohortGate",
            advanceAllPolicyDefinition: {
              rules: [],
              defaultEventType: "continue",
              defaultEventParamsJson: null,
            },
            stepSignalsListDefinitions: [],
          },
        ],
        dependencyEdges: [
          { fromNodeKey: "review", toNodeKey: "review__cohortGate" },
        ],
      });

      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.upsertFromSpec(
          "proj-1",
          spec,
          [{ id: "step-def-id", key: "review", version: 1 }],
          { headers: AUTH_HEADER },
        );
      } finally {
        globalThis.fetch = prev;
      }

      expect(captured).toHaveLength(1);
      const body = captured[0]?.body as {
        nodeDefinitions: Array<{ key: string; kind: string; configJson: unknown }>;
      };
      const fanOutNode = body.nodeDefinitions.find((n) => n.key === "review");
      const gateNode = body.nodeDefinitions.find(
        (n) => n.key === "review__cohortGate",
      );
      expect(fanOutNode?.kind).toBe("fanOut");
      expect(fanOutNode?.configJson).toMatchObject({
        overSignalKey: "reviewer_count",
      });
      expect(gateNode?.kind).toBe("cohortGate");
    });

    test("omits inputBindingsJson/timeoutSeconds for terminal succeed/fail nodes", async () => {
      const { mockFetch, captured } = createMockFetch([
        { status: 200, body: { id: "pipeline-id" } },
      ]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;

      const spec = makeSpec({
        nodeDefinitions: [
          { nodeKey: "done", kind: "succeed" },
          { nodeKey: "failed", kind: "fail" },
        ],
        dependencyEdges: [],
      });

      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.upsertFromSpec("proj-1", spec, [], {
          headers: AUTH_HEADER,
        });
      } finally {
        globalThis.fetch = prev;
      }

      expect(captured).toHaveLength(1);
      const body = captured[0]?.body as {
        nodeDefinitions: Array<{
          key: string;
          kind: string;
          inputBindingsJson: unknown;
        }>;
      };
      const succeedNode = body.nodeDefinitions.find((n) => n.key === "done");
      const failNode = body.nodeDefinitions.find((n) => n.key === "failed");
      // Must be null, not `{}` — the server rejects any non-null
      // inputBindingsJson on non-working node kinds
      // (NODE_DEFINITION_INPUT_BINDINGS_NOT_ALLOWED).
      expect(succeedNode?.inputBindingsJson).toBeNull();
      expect(failNode?.inputBindingsJson).toBeNull();
    });

    test("throws when the server returns an error status", async () => {
      const { mockFetch } = createMockFetch([
        { status: 422, body: { title: "Bad request" } },
      ]);
      const prev = globalThis.fetch;
      globalThis.fetch = mockFetch;

      let caughtError: unknown;
      try {
        const client = createPipelineDefinitionsClient(BASE_URL);
        await client.upsertFromSpec(
          "proj-1",
          makeSpec(),
          [{ id: "step-def-id", key: "investigate", version: 1 }],
          { headers: AUTH_HEADER },
        );
      } catch (err) {
        caughtError = err;
      } finally {
        globalThis.fetch = prev;
      }
      expect(caughtError).toBeInstanceOf(Error);
    });
  });
});
