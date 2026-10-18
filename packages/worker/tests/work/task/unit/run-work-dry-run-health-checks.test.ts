import { afterEach, describe, expect, test } from "bun:test";
import { checkOpencodeHealth } from "../../../../src/work/task/application/run-work-dry-run-health-checks";

const previousFetch = globalThis.fetch;

const SERVER = {
  baseUrl: "http://127.0.0.1:4096",
  password: "test-password",
  workspaceFolder: "/workspaces/repo",
};

function respondWith(response: () => Response): void {
  globalThis.fetch = (() =>
    Promise.resolve(response())) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = previousFetch;
});

describe("checkOpencodeHealth", () => {
  test("reports healthy when the server answers with the expected version", async () => {
    respondWith(() => Response.json({ version: "2.0.28" }));

    expect(await checkOpencodeHealth(SERVER, "2.0.28")).toEqual({
      healthy: true,
    });
  });

  test("reports unhealthy on an HTML 200 (the web shell, not the API)", async () => {
    respondWith(
      () =>
        new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    expect((await checkOpencodeHealth(SERVER, "2.0.28")).healthy).toBe(false);
  });

  test("reports unhealthy with the status code on a non-200 response", async () => {
    respondWith(() => new Response(null, { status: 401 }));

    expect(await checkOpencodeHealth(SERVER, "2.0.28")).toEqual({
      healthy: false,
      detail: "HTTP 401",
    });
  });

  test("reports unhealthy when the server runs a different version", async () => {
    respondWith(() => Response.json({ version: "1.17.3" }));

    expect(await checkOpencodeHealth(SERVER, "2.0.28")).toEqual({
      healthy: false,
      detail: "/api/info reports version 1.17.3, expected 2.0.28",
    });
  });

  test("reports unhealthy with the error message when the request throws", async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        new Error("connect ECONNREFUSED"),
      )) as unknown as typeof fetch;

    expect(await checkOpencodeHealth(SERVER, "2.0.28")).toEqual({
      healthy: false,
      detail: "connect ECONNREFUSED",
    });
  });
});
