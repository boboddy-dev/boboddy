/**
 * Unit tests for the pure git mirror key helpers. No git is run; these pin the
 * URL normalisation contract in `docs/plans/git-mirror-cache.md`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  isCacheableUrl,
  mirrorKey,
  normaliseGitUrl,
} from "../../../../src/runtime/runtime-service/domain/git-mirror-key";

describe("normaliseGitUrl", () => {
  const cases: Array<[label: string, input: string, expected: string]> = [
    [
      "plain https",
      "https://github.com/acme/repo",
      "https://github.com/acme/repo",
    ],
    [
      "uppercase scheme and host",
      "HTTPS://GitHub.COM/acme/repo",
      "https://github.com/acme/repo",
    ],
    [
      "path case is preserved",
      "https://github.com/Acme/Repo",
      "https://github.com/Acme/Repo",
    ],
    [
      "trailing .git",
      "https://github.com/acme/repo.git",
      "https://github.com/acme/repo",
    ],
    [
      "trailing slash",
      "https://github.com/acme/repo/",
      "https://github.com/acme/repo",
    ],
    [
      "trailing .git and slash",
      "https://github.com/acme/repo.git/",
      "https://github.com/acme/repo",
    ],
    [
      "multiple trailing slashes",
      "https://github.com/acme/repo///",
      "https://github.com/acme/repo",
    ],
    [
      "only one .git suffix stripped",
      "https://github.com/acme/repo.git.git",
      "https://github.com/acme/repo.git",
    ],
    [
      "a .git infix is kept",
      "https://github.com/acme/repo.github.io",
      "https://github.com/acme/repo.github.io",
    ],
    [
      "username dropped",
      "https://user@github.com/acme/repo",
      "https://github.com/acme/repo",
    ],
    [
      "query dropped",
      "https://github.com/acme/repo.git?foo=bar",
      "https://github.com/acme/repo",
    ],
    [
      "fragment dropped",
      "https://github.com/acme/repo.git#main",
      "https://github.com/acme/repo",
    ],
    [
      "query and fragment dropped",
      "https://github.com/acme/repo?a=1#frag",
      "https://github.com/acme/repo",
    ],
    [
      "port kept",
      "https://git.example.com:8443/acme/repo.git",
      "https://git.example.com:8443/acme/repo",
    ],
    [
      "ssh scheme kept",
      "ssh://git@github.com/acme/repo.git",
      "ssh://github.com/acme/repo",
    ],
    [
      "ssh port kept",
      "ssh://git@host.example.com:2222/acme/repo",
      "ssh://host.example.com:2222/acme/repo",
    ],
    ["SCP-style", "git@github.com:acme/repo.git", "ssh://github.com/acme/repo"],
    [
      "SCP-style uppercase host",
      "git@GitHub.com:acme/repo",
      "ssh://github.com/acme/repo",
    ],
    [
      "SCP-style without user",
      "github.com:acme/repo.git",
      "ssh://github.com/acme/repo",
    ],
    [
      "SCP-style with absolute path",
      "git@host.example.com:/srv/git/repo.git",
      "ssh://host.example.com/srv/git/repo",
    ],
    [
      "SCP-style trailing slash",
      "git@github.com:acme/repo/",
      "ssh://github.com/acme/repo",
    ],
    [
      "git scheme",
      "git://github.com/acme/repo.git",
      "git://github.com/acme/repo",
    ],
    [
      "absolute local path",
      "/tmp/remotes/repo.git",
      "file:///tmp/remotes/repo",
    ],
    ["file URL", "file:///tmp/remotes/repo.git", "file:///tmp/remotes/repo"],
    [
      "surrounding whitespace",
      "  https://github.com/acme/repo.git  ",
      "https://github.com/acme/repo",
    ],
  ];

  test.each(cases)("%s", (_label, input, expected) => {
    expect(normaliseGitUrl(input)).toBe(expected);
  });

  test("drops the password and token from userinfo", () => {
    expect(
      normaliseGitUrl("https://user:s3cret@github.com/acme/repo.git"),
    ).toBe("https://github.com/acme/repo");
    expect(normaliseGitUrl("https://ghp_abcdef@github.com/acme/repo")).toBe(
      "https://github.com/acme/repo",
    );
  });

  test("keeps scheme significant: https and ssh do not normalise equal", () => {
    expect(normaliseGitUrl("https://github.com/acme/repo")).not.toBe(
      normaliseGitUrl("ssh://github.com/acme/repo"),
    );
  });

  test.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["relative path", "../repo.git"],
    ["bare name", "repo"],
    ["unsupported scheme", "ftp://example.com/repo.git"],
    ["ext transport", "ext::sh -c 'echo hi'"],
    ["missing host", "https:///acme/repo"],
    ["non-numeric port", "https://example.com:abc/repo"],
    ["bracketed IPv6 SCP", "git@[::1]:acme/repo"],
  ])("returns null for %s", (_label, input) => {
    expect(normaliseGitUrl(input)).toBeNull();
  });
});

describe("mirrorKey", () => {
  test("is 16 lowercase hex chars", () => {
    expect(mirrorKey("https://github.com/acme/repo.git")).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  test("equals the first 16 hex chars of sha256 of the normalised URL", () => {
    const expected = createHash("sha256")
      .update("https://github.com/acme/repo")
      .digest("hex")
      .slice(0, 16);
    expect(mirrorKey("HTTPS://user@GitHub.com/acme/repo.git/?x=1")).toBe(
      expected,
    );
  });

  test("is the same for https://user@host/x and https://host/x", () => {
    expect(mirrorKey("https://user@github.com/acme/repo")).toBe(
      mirrorKey("https://github.com/acme/repo"),
    );
  });

  test("is the same for SCP-style and ssh:// forms", () => {
    expect(mirrorKey("git@github.com:acme/repo.git")).toBe(
      mirrorKey("ssh://github.com/acme/repo"),
    );
    expect(mirrorKey("git@github.com:acme/repo.git")).toBe(
      mirrorKey("ssh://other@github.com/acme/repo/"),
    );
  });

  test("ignores case of scheme and host, trailing .git and trailing slash", () => {
    const key = mirrorKey("https://github.com/acme/repo");
    expect(mirrorKey("HTTPS://GITHUB.COM/acme/repo")).toBe(key);
    expect(mirrorKey("https://github.com/acme/repo.git")).toBe(key);
    expect(mirrorKey("https://github.com/acme/repo/")).toBe(key);
    expect(mirrorKey("https://github.com/acme/repo.git/")).toBe(key);
    expect(mirrorKey("https://github.com/acme/repo?tab=readme")).toBe(key);
  });

  test("differs by scheme, port and path", () => {
    const keys = new Set([
      mirrorKey("https://github.com/acme/repo"),
      mirrorKey("ssh://github.com/acme/repo"),
      mirrorKey("https://github.com:8443/acme/repo"),
      mirrorKey("https://github.com/acme/other"),
      mirrorKey("https://github.com/Acme/repo"),
    ]);
    expect(keys.size).toBe(5);
  });

  test("never contains userinfo", () => {
    const urls = [
      "https://ghp_abcdef0123456789@github.com/acme/repo",
      "https://alice:hunter2@github.com/acme/repo",
      "ssh://deploy@github.com/acme/repo",
    ];
    for (const url of urls) {
      const key = mirrorKey(url);
      expect(key).not.toBeNull();
      for (const secret of ["ghp_", "alice", "hunter2", "deploy", "@", ":"]) {
        expect(key).not.toContain(secret);
      }
    }
  });

  test("returns null when the URL cannot be normalised", () => {
    expect(mirrorKey("not a url")).toBeNull();
    expect(mirrorKey("")).toBeNull();
  });
});

describe("isCacheableUrl", () => {
  test.each([
    "https://github.com/acme/repo.git",
    "https://alice@github.com/acme/repo.git",
    "http://git.example.com/acme/repo",
    "https://git.example.com:8443/acme/repo",
    "ssh://git@github.com/acme/repo.git",
    "git@github.com:acme/repo.git",
    "github.com:acme/repo.git",
    "git://github.com/acme/repo.git",
    "/tmp/remotes/repo.git",
    "file:///tmp/remotes/repo.git",
  ])("true for %s", (url) => {
    expect(isCacheableUrl(url)).toBe(true);
  });

  test.each([
    [
      "password in https userinfo",
      "https://alice:hunter2@github.com/acme/repo.git",
    ],
    ["empty password", "https://alice:@github.com/acme/repo.git"],
    [
      "x-access-token form",
      "https://x-access-token:ghs_abc123@github.com/acme/repo.git",
    ],
    ["oauth2 form", "https://oauth2:glpat-abc123@gitlab.com/acme/repo.git"],
    ["password in ssh userinfo", "ssh://git:secret@github.com/acme/repo.git"],
    [
      "classic PAT as username",
      "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/repo.git",
    ],
    [
      "fine-grained PAT as username",
      "https://github_pat_11ABCDEFG0abcdefghijkl@github.com/acme/repo.git",
    ],
    [
      "gitlab token as username",
      "https://glpat-abcdefghij1234567890@gitlab.com/acme/repo.git",
    ],
    [
      "short ghp_ token as username",
      "https://ghp_abc@github.com/acme/repo.git",
    ],
    [
      "long hex token as username",
      "https://0123456789abcdef0123456789abcdef01234567@host.example.com/acme/repo.git",
    ],
    [
      "percent-encoded userinfo https",
      "https://user%3Apass@github.com/acme/repo.git",
    ],
    [
      "percent-encoded userinfo ssh",
      "ssh://user%3Apass@github.com/acme/repo.git",
    ],
    ["unparseable", "not a url"],
    ["empty", ""],
    ["relative path", "./repo.git"],
  ])("false for %s", (_label, url) => {
    expect(isCacheableUrl(url)).toBe(false);
  });
});
