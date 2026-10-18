import { afterEach, describe, expect, test } from "bun:test";
import { createBoboddyClient } from "../src/client";
import {
  ProjectRefError,
  resolveProjectRef,
} from "../src/defaults/project-ref";

const BASE_URL = "https://boboddy.example.com";
const headers = { Authorization: "Bearer token" };
const previousFetch = globalThis.fetch;

function respondWith(status: number, body: object): string[] {
  const requested: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const request = input instanceof Request ? input : new Request(input);
    requested.push(request.url);
    return Promise.resolve(Response.json(body, { status }));
  }) as unknown as typeof globalThis.fetch;
  return requested;
}

async function captureError(
  promise: Promise<unknown>,
): Promise<ProjectRefError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProjectRefError) return error;
    throw error;
  }
  throw new Error("expected resolveProjectRef to throw");
}

describe("resolveProjectRef", () => {
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  test("resolves owner/slug to the project id", async () => {
    const requested = respondWith(200, { id: "project-uuid" });

    const resolved = await resolveProjectRef(
      createBoboddyClient(BASE_URL),
      "acme/web-app",
      { headers },
    );

    expect(resolved).toEqual({
      id: "project-uuid",
      owner: "acme",
      slug: "web-app",
    });
    expect(requested).toEqual([
      `${BASE_URL}/api/projects/resolve?username=acme&slug=web-app`,
    ]);
  });

  test("rejects a malformed ref without calling the server", async () => {
    const requested = respondWith(200, { id: "project-uuid" });

    const error = await captureError(
      resolveProjectRef(createBoboddyClient(BASE_URL), "web-app", { headers }),
    );

    expect(error.kind).toBe("invalid");
    expect(error.message).toContain('"web-app" is not a valid project.');
    expect(requested).toEqual([]);
  });

  test("names the ref on a 404", async () => {
    respondWith(404, {
      type: "x",
      title: "Not Found",
      status: 404,
      detail: "Project acme/web-app not found",
    });

    const error = await captureError(
      resolveProjectRef(createBoboddyClient(BASE_URL), "acme/web-app", {
        headers,
      }),
    );

    expect(error.kind).toBe("not_found");
    expect(error.message).toBe(
      'No project acme/web-app. Check "project" in .boboddy/boboddy.jsonc — the owner may have renamed their username.',
    );
  });

  test("names the ref and the action on a 403", async () => {
    respondWith(403, { type: "x", title: "Forbidden", status: 403 });

    const error = await captureError(
      resolveProjectRef(createBoboddyClient(BASE_URL), "acme/web-app", {
        headers,
        action: "run work for",
      }),
    );

    expect(error.kind).toBe("forbidden");
    expect(error.message).toBe(
      "You don't have permission to run work for acme/web-app.",
    );
  });

  test("defaults the 403 action to view", async () => {
    respondWith(403, { type: "x", title: "Forbidden", status: 403 });

    const error = await captureError(
      resolveProjectRef(createBoboddyClient(BASE_URL), "acme/web-app", {
        headers,
      }),
    );

    expect(error.message).toBe(
      "You don't have permission to view acme/web-app.",
    );
  });
});
