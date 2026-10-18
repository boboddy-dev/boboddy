import { describe, expect, test } from "bun:test";
import { injectOpencodeCredentials } from "../../../../src/runtime/runtime-service/infra/opencode-credential-injection";
import type { OpencodeCredential } from "../../../../src/runtime/runtime-service/infra/opencode-credential-source";

const BASE_URL = "http://127.0.0.1:4096";

const anthropic: OpencodeCredential = {
  integrationID: "anthropic",
  source: "export",
  value: { type: "key", key: "sk-secret" },
};

type RecordedRequest = { method: string; url: string; body: string | null };

/**
 * A fake `fetch` answering `GET /api/integration/{id}` from `integrationStatuses`
 * (one status per poll, the last repeating) and `POST /api/credential` with
 * `postStatus`.
 */
function fakeServer(input: {
  integrationStatuses: Record<string, number[]>;
  postStatus?: number;
}): { fetchFn: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const polls = new Map<string, number>();
  const fetchFn = ((url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    requests.push({
      method,
      url,
      body: typeof init.body === "string" ? init.body : null,
    });
    if (method === "POST") {
      return Promise.resolve(
        new Response(null, { status: input.postStatus ?? 200 }),
      );
    }
    const id = decodeURIComponent(url.split("/api/integration/")[1] ?? "");
    const statuses = input.integrationStatuses[id] ?? [404];
    const poll = polls.get(id) ?? 0;
    polls.set(id, poll + 1);
    const status = statuses[Math.min(poll, statuses.length - 1)] ?? 404;
    return Promise.resolve(new Response("{}", { status }));
  }) as typeof fetch;
  return { fetchFn, requests };
}

/** A virtual clock advanced by `sleep`, so polling runs without real waits. */
function virtualClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms: number) => {
      time += ms;
      return Promise.resolve();
    },
  };
}

describe("injectOpencodeCredentials", () => {
  test("waits for the integration to appear, then posts the credential", async () => {
    const { fetchFn, requests } = fakeServer({
      integrationStatuses: { anthropic: [404, 404, 200] },
    });

    const result = await injectOpencodeCredentials({
      baseUrl: BASE_URL,
      password: "pw",
      credentials: [anthropic],
      fetchFn,
      ...virtualClock(),
    });

    expect(result).toEqual({ injected: ["anthropic"], skipped: [] });
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${BASE_URL}/api/integration/anthropic`,
      `GET ${BASE_URL}/api/integration/anthropic`,
      `GET ${BASE_URL}/api/integration/anthropic`,
      `POST ${BASE_URL}/api/credential`,
    ]);
    expect(JSON.parse(requests[3]?.body ?? "")).toEqual({
      integrationID: "anthropic",
      value: { type: "key", key: "sk-secret" },
    });
  });

  test("skips an integration that never appears within the wait, without failing", async () => {
    const { fetchFn, requests } = fakeServer({
      integrationStatuses: { anthropic: [200] },
    });
    const unknown: OpencodeCredential = {
      integrationID: "not-a-provider",
      source: "env",
      value: { type: "key", key: "sk-other" },
    };

    const result = await injectOpencodeCredentials({
      baseUrl: BASE_URL,
      password: "pw",
      credentials: [unknown, anthropic],
      fetchFn,
      integrationWaitMs: 1_000,
      ...virtualClock(),
    });

    expect(result).toEqual({
      injected: ["anthropic"],
      skipped: ["not-a-provider"],
    });
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  test("reports a rejected post as skipped", async () => {
    const { fetchFn } = fakeServer({
      integrationStatuses: { anthropic: [200] },
      postStatus: 400,
    });

    const result = await injectOpencodeCredentials({
      baseUrl: BASE_URL,
      password: "pw",
      credentials: [anthropic],
      fetchFn,
      ...virtualClock(),
    });

    expect(result).toEqual({ injected: [], skipped: ["anthropic"] });
  });

  test("survives network errors while polling", async () => {
    let calls = 0;
    const fetchFn = ((_url: string, init: RequestInit = {}) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new TypeError("connection refused"));
      }
      return Promise.resolve(
        new Response(null, { status: init.method === "POST" ? 204 : 200 }),
      );
    }) as typeof fetch;

    const result = await injectOpencodeCredentials({
      baseUrl: BASE_URL,
      password: "pw",
      credentials: [anthropic],
      fetchFn,
      ...virtualClock(),
    });

    expect(result.injected).toEqual(["anthropic"]);
  });
});
