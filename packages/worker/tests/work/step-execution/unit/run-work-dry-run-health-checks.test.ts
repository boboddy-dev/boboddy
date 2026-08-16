import { afterEach, describe, expect, test } from "bun:test";
import { checkOpencodeHealth } from "../../../../src/work/step-execution/application/run-work-dry-run-health-checks";

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

describe("checkOpencodeHealth", () => {
  test("reports healthy on a 200 response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;

    expect(await checkOpencodeHealth("http://127.0.0.1:4096")).toEqual({
      healthy: true,
    });
  });

  test("reports unhealthy with the status code on a non-2xx response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(null, { status: 503 }))) as unknown as typeof fetch;

    expect(await checkOpencodeHealth("http://127.0.0.1:4096")).toEqual({
      healthy: false,
      detail: "HTTP 503",
    });
  });

  test("reports unhealthy with the error message when the request throws", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;

    expect(await checkOpencodeHealth("http://127.0.0.1:4096")).toEqual({
      healthy: false,
      detail: "connect ECONNREFUSED",
    });
  });
});
