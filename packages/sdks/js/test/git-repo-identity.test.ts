import { describe, expect, test } from "bun:test";
import {
  gitRepoIdentity,
  isSameGitRepo,
  parseGitHubRepo,
  stripGitUrlCredentials,
} from "../src/git-url/git-repo-identity";

describe("gitRepoIdentity", () => {
  test.each([
    ["git@github.com:acme/repo.git", "github.com/acme/repo"],
    ["git@github.com:acme/repo", "github.com/acme/repo"],
    ["github.com:acme/repo.git", "github.com/acme/repo"],
    ["https://github.com/acme/repo.git", "github.com/acme/repo"],
    ["https://github.com/acme/repo", "github.com/acme/repo"],
    ["https://github.com/acme/repo/", "github.com/acme/repo"],
    ["https://github.com/acme/repo.git/", "github.com/acme/repo"],
    ["http://github.com/acme/repo.git", "github.com/acme/repo"],
    ["ssh://git@github.com/acme/repo.git", "github.com/acme/repo"],
    ["ssh://git@github.com:22/acme/repo.git", "github.com/acme/repo"],
    ["git+ssh://git@github.com/acme/repo.git", "github.com/acme/repo"],
    ["git://github.com/acme/repo.git", "github.com/acme/repo"],
    ["https://github.com:443/acme/repo.git", "github.com/acme/repo"],
    [
      "https://user:ghp_secret@github.com/acme/repo.git",
      "github.com/acme/repo",
    ],
    ["https://x-access-token@github.com/acme/repo.git", "github.com/acme/repo"],
    ["HTTPS://GitHub.COM/Acme/Repo.git", "github.com/acme/repo"],
    ["git@GitHub.com:Acme/Repo.git", "github.com/acme/repo"],
    ["  https://github.com/acme/repo.git  ", "github.com/acme/repo"],
    ["https://github.com/acme/repo.git?x=1#frag", "github.com/acme/repo"],
  ])("%s → %s", (input, expected) => {
    expect(gitRepoIdentity(input)).toBe(expected);
  });

  test("keeps path case for hosts other than github.com", () => {
    expect(gitRepoIdentity("https://GitLab.com/Acme/Repo.git")).toBe(
      "gitlab.com/Acme/Repo",
    );
    expect(gitRepoIdentity("git@gitlab.com:Acme/Repo.git")).toBe(
      "gitlab.com/Acme/Repo",
    );
  });

  test("keeps a non-default port", () => {
    expect(
      gitRepoIdentity("ssh://git@git.example.com:2222/acme/repo.git"),
    ).toBe("git.example.com:2222/acme/repo");
    expect(gitRepoIdentity("https://git.example.com:8443/acme/repo")).toBe(
      "git.example.com:8443/acme/repo",
    );
  });

  test.each([
    ["/home/me/repo"],
    ["/home/me/repo.git"],
    ["./repo"],
    ["../repo.git"],
    ["repo"],
    ["file:///home/me/repo.git"],
    ["file://localhost/home/me/repo.git"],
    ["C:\\code\\repo"],
    ["ftp://example.com/acme/repo.git"],
    ["https://github.com"],
    ["https://github.com/"],
    [""],
  ])("returns null for %j", (input) => {
    expect(gitRepoIdentity(input)).toBeNull();
  });
});

describe("isSameGitRepo", () => {
  test("matches an SSH remote against the HTTPS form the GitHub picker stores", () => {
    expect(
      isSameGitRepo(
        "git@github.com:Acme/Repo.git",
        "https://github.com/acme/repo.git",
      ),
    ).toBe(true);
  });

  test("does not match different repositories", () => {
    expect(
      isSameGitRepo(
        "git@github.com:acme/repo.git",
        "https://github.com/acme/other.git",
      ),
    ).toBe(false);
  });

  test("falls back to exact equality when either side has no identity", () => {
    expect(isSameGitRepo("/srv/repo.git", "/srv/repo.git")).toBe(true);
    expect(isSameGitRepo("/srv/repo.git", "/srv/repo")).toBe(false);
    expect(
      isSameGitRepo("/srv/repo.git", "https://github.com/acme/repo.git"),
    ).toBe(false);
  });
});

describe("stripGitUrlCredentials", () => {
  test.each([
    [
      "https://user:ghp_secret@github.com/acme/repo.git",
      "https://github.com/acme/repo.git",
    ],
    [
      "https://ghp_token@github.com/acme/repo.git",
      "https://github.com/acme/repo.git",
    ],
    [
      "http://user:pw@git.example.com:8080/acme/repo",
      "http://git.example.com:8080/acme/repo",
    ],
    [
      "ssh://git:secret@github.com/acme/repo.git",
      "ssh://git@github.com/acme/repo.git",
    ],
    [
      "ssh://git@github.com/acme/repo.git",
      "ssh://git@github.com/acme/repo.git",
    ],
    ["git@github.com:acme/repo.git", "git@github.com:acme/repo.git"],
    ["https://github.com/acme/repo.git", "https://github.com/acme/repo.git"],
    ["/home/me/repo", "/home/me/repo"],
  ])("%s → %s", (input, expected) => {
    expect(stripGitUrlCredentials(input)).toBe(expected);
  });
});

describe("parseGitHubRepo", () => {
  test.each([
    ["git@github.com:Acme/Repo.git", { owner: "Acme", name: "Repo" }],
    ["https://github.com/acme/repo", { owner: "acme", name: "repo" }],
    [
      "https://token@github.com/acme/repo.git/",
      { owner: "acme", name: "repo" },
    ],
    ["ssh://git@github.com/acme/repo.git", { owner: "acme", name: "repo" }],
  ])("%s → %j", (input, expected) => {
    expect(parseGitHubRepo(input)).toEqual(expected);
  });

  test.each([
    ["https://gitlab.com/acme/repo.git"],
    ["https://github.com/acme"],
    ["https://github.com/acme/repo/tree/main"],
    ["https://github.com:8443/acme/repo.git"],
    ["/home/me/repo"],
  ])("returns null for %s", (input) => {
    expect(parseGitHubRepo(input)).toBeNull();
  });
});
