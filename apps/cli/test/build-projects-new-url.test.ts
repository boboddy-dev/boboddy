import { describe, expect } from "bun:test";
import { buildProjectsNewUrl } from "../src/lib/build-projects-new-url";
import { concurrentTest as test } from "./utils";

describe("buildProjectsNewUrl", () => {
  test("builds /projects/new with gitUrl and name query params", () => {
    const url = buildProjectsNewUrl({
      baseUrl: "https://app.boboddy.dev",
      gitUrl: "git@github.com:acme/my-repo.git",
      suggestedName: "my-repo",
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://app.boboddy.dev");
    expect(parsed.pathname).toBe("/projects/new");
    expect(parsed.searchParams.get("gitUrl")).toBe(
      "git@github.com:acme/my-repo.git",
    );
    expect(parsed.searchParams.get("name")).toBe("my-repo");
  });

  test("respects a non-default base URL (e.g. --base-url / BOBODDY_BASE_URL)", () => {
    const url = buildProjectsNewUrl({
      baseUrl: "http://localhost:3000",
      gitUrl: "https://example.com/acme/my-repo.git",
      suggestedName: "my-repo",
    });

    expect(url.startsWith("http://localhost:3000/projects/new?")).toBe(true);
  });
});
