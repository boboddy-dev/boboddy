import { afterEach, describe, expect, test, vi } from "bun:test";
import { DefaultOpencodeStepRunner } from "../../../../src/work/task/infra/opencode-step-runner";

const SERVER = {
  baseUrl: "http://127.0.0.1:4096",
  password: "test-password",
  workspaceFolder: "/workspaces/repo",
};

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

// eslint-disable-next-line local/no-unknown-parameter-type -- test helper serializes arbitrary JSON fixtures
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type RecordedRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
};

/** Routes v2 `/api/*` requests to `handler`, recording every one. */
function installFetch(
  handler: (request: RecordedRequest) => Response,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: new URL(input instanceof Request ? input.url : input.toString()),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    return Promise.resolve(handler(request));
  }) as unknown as typeof fetch;
  return requests;
}

function assistantMessage(retry?: {
  attempt: number;
  error: { type: string; message: string };
}) {
  return {
    id: "msg-1",
    type: "assistant",
    time: { created: 0 },
    agent: "build",
    model: { id: "claude", providerID: "anthropic" },
    content: [],
    ...(retry ? { retry: { ...retry, at: 1 } } : {}),
  };
}

describe("DefaultOpencodeStepRunner", () => {
  test("treats a session listed in GET /api/session/active as running", async () => {
    installFetch(({ url }) => {
      if (url.pathname === "/api/session/active") {
        return jsonResponse({ data: { "session-busy": { type: "running" } } });
      }
      if (url.pathname === "/api/session/session-busy/message") {
        return jsonResponse({
          data: [assistantMessage()],
          cursor: { previous: null, next: null },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const runner = new DefaultOpencodeStepRunner();

    expect(
      await runner.getSessionStatus({
        server: SERVER,
        sessionId: "session-busy",
      }),
    ).toEqual({ running: true, providerError: undefined });
  });

  test("surfaces the latest assistant message's retry as a provider error", async () => {
    const requests = installFetch(({ url }) => {
      if (url.pathname === "/api/session/active") {
        return jsonResponse({ data: { "session-retry": { type: "running" } } });
      }
      if (url.pathname === "/api/session/session-retry/message") {
        return jsonResponse({
          data: [
            assistantMessage({
              attempt: 2,
              error: { type: "provider.internal", message: "Upstream 500" },
            }),
          ],
          cursor: { previous: null, next: null },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const runner = new DefaultOpencodeStepRunner();

    expect(
      await runner.getSessionStatus({
        server: SERVER,
        sessionId: "session-retry",
      }),
    ).toEqual({
      running: true,
      providerError: { attempt: 2, message: "Upstream 500" },
    });

    const messageRequest = requests.find((request) =>
      request.url.pathname.endsWith("/message"),
    );
    expect(Object.fromEntries(messageRequest?.url.searchParams ?? [])).toEqual({
      type: "assistant",
      order: "desc",
      limit: "1",
    });
  });

  test("treats a session absent from GET /api/session/active as stopped, without reading messages", async () => {
    const requests = installFetch(({ url }) => {
      if (url.pathname === "/api/session/active") {
        return jsonResponse({ data: {} });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const runner = new DefaultOpencodeStepRunner();

    expect(
      await runner.getSessionStatus({
        server: SERVER,
        sessionId: "session-idle",
      }),
    ).toEqual({ running: false });
    expect(requests).toHaveLength(1);
  });

  test("promptAsync creates the session with its agent and location, calls onSessionCreated, then prompts", async () => {
    // Regression test for the missing-initial-prompt bug: the caller's
    // conversation-stream subscription (wired via `onSessionCreated`) must be
    // attached before the prompt request goes out, because the v2 event stream
    // is live-only and never replays the session's opening events.
    const calls: string[] = [];
    const requests = installFetch(({ method, url }) => {
      if (method === "POST" && url.pathname === "/api/session") {
        calls.push("session.create");
        return jsonResponse({ data: { id: "session-new" } });
      }
      if (
        method === "POST" &&
        url.pathname === "/api/session/session-new/prompt"
      ) {
        calls.push("session.prompt");
        return jsonResponse({ data: { id: "inbox-1" } });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });

    const runner = new DefaultOpencodeStepRunner();
    const onSessionCreated = vi.fn(() => {
      calls.push("onSessionCreated");
    });

    const result = await runner.promptAsync({
      server: SERVER,
      sessionTitle: "Demo Step",
      promptText: "Do the thing",
      agent: "build",
      onSessionCreated,
    });

    expect(result).toEqual({ sessionId: "session-new" });
    expect(onSessionCreated).toHaveBeenCalledWith({ sessionId: "session-new" });
    expect(calls).toEqual([
      "session.create",
      "onSessionCreated",
      "session.prompt",
    ]);

    const [create, prompt] = requests;
    expect(create?.body).toEqual({
      title: "Demo Step",
      agent: "build",
      location: { directory: "/workspaces/repo" },
    });
    expect(prompt?.body).toEqual({ text: "Do the thing" });
    expect(create?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("opencode:test-password").toString("base64")}`,
    );
  });

  test("sendRetryPrompt posts the text to the existing session", async () => {
    const requests = installFetch(({ method, url }) => {
      if (
        method === "POST" &&
        url.pathname === "/api/session/session-1/prompt"
      ) {
        return jsonResponse({ data: { id: "inbox-2" } });
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });

    await new DefaultOpencodeStepRunner().sendRetryPrompt({
      server: SERVER,
      sessionId: "session-1",
      promptText: "Try again",
      agent: "build",
    });

    expect(requests.map((request) => request.body)).toEqual([
      { text: "Try again" },
    ]);
  });
});
