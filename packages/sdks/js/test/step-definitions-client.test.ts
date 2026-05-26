import { describe, expect, test } from "bun:test";
import { createStepDefinitionsClient } from "../src/definitions/steps/step-definitions-client";
import type { StepDefinitionSpec } from "../src/definitions/steps/define-step";

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
): Promise<{ url: string; method: string; headers: Record<string, string>; body: unknown }> {
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
          Object.entries((rawHeaders as Record<string, string> | undefined) ?? {}),
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

function makeSpec(overrides?: Partial<StepDefinitionSpec>): StepDefinitionSpec {
  return {
    key: "investigate",
    name: "Investigate",
    description: null,
    version: 1,
    kind: "user_defined",
    status: "active",
    prompt: "Investigate the issue.",
    inputSchemaJson: null,
    resultSchemaJson: null,
    signalExtractorDefinitions: [],
    opencodeMcpJson: null,
    ...overrides,
  };
}

describe("createStepDefinitionsClient.upsertFromSpec", () => {
  test("sends PUT to /api/step-definitions with body = { ...spec, projectId }", async () => {
    const { mockFetch, captured } = createMockFetch([
      { status: 200, body: { id: "step-id" } },
    ]);
    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const client = createStepDefinitionsClient(BASE_URL);
      const spec = makeSpec();
      await client.upsertFromSpec("proj-1", spec, { headers: AUTH_HEADER });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.method).toBe("PUT");
      expect(captured[0]?.url).toBe(`${BASE_URL}/api/step-definitions`);
      expect(captured[0]?.body).toEqual({
        ...spec,
        projectId: "proj-1",
      });
      // Headers.entries() lowercases header names per the WHATWG spec.
      expect(captured[0]?.headers["authorization"]).toBe("Bearer test-token");
    } finally {
      globalThis.fetch = prev;
    }
  });

  test("returns the parsed response body", async () => {
    const { mockFetch } = createMockFetch([
      { status: 200, body: { id: "step-id", key: "investigate" } },
    ]);
    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const client = createStepDefinitionsClient(BASE_URL);
      const result = await client.upsertFromSpec("proj-1", makeSpec(), {
        headers: AUTH_HEADER,
      });
      expect(result).toMatchObject({ id: "step-id", key: "investigate" });
    } finally {
      globalThis.fetch = prev;
    }
  });

  test("throws when the server returns an error status", async () => {
    const { mockFetch } = createMockFetch([
      { status: 422, body: { title: "Invalid spec" } },
    ]);
    const prev = globalThis.fetch;
    globalThis.fetch = mockFetch;

    let caughtError: unknown;
    try {
      const client = createStepDefinitionsClient(BASE_URL);
      await client.upsertFromSpec("proj-1", makeSpec(), {
        headers: AUTH_HEADER,
      });
    } catch (err) {
      caughtError = err;
    } finally {
      globalThis.fetch = prev;
    }
    expect(caughtError).toBeInstanceOf(Error);
  });
});
