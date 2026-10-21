import { describe, expect, test } from "bun:test";
import { type GitHost, parseGitHost } from "../src/git-url/git-repo-identity";

const acmeGitHub: GitHost = {
  host: "github",
  owner: "acme",
  name: "repo",
  webUrl: "https://github.com/acme/repo",
};

const acmeBitbucket: GitHost = {
  host: "bitbucket",
  workspace: "acme",
  slug: "repo",
  webUrl: "https://bitbucket.org/acme/repo",
};

describe("parseGitHost", () => {
  test.concurrent.each([
    ["https://github.com/acme/repo"],
    ["https://github.com/acme/repo.git"],
    ["https://github.com/acme/repo.git/"],
    ["http://github.com/acme/repo"],
    ["https://github.com:443/acme/repo.git"],
    ["ssh://git@github.com/acme/repo.git"],
    ["ssh://git@github.com:22/acme/repo.git"],
    ["git+ssh://git@github.com/acme/repo.git"],
    ["git://github.com/acme/repo.git"],
    ["git@github.com:acme/repo.git"],
    ["github.com:acme/repo"],
    ["https://user:ghp_secret@github.com/acme/repo.git"],
    ["https://x-access-token@github.com/acme/repo.git"],
    ["ssh://git:secret@github.com/acme/repo.git"],
    ["HTTPS://GitHub.COM/acme/repo.git"],
    ["git@GITHUB.com:acme/repo.git"],
    ["  https://github.com/acme/repo.git?ref=main#readme  "],
  ])("%s is the github acme/repo", (input) => {
    expect(parseGitHost(input)).toEqual(acmeGitHub);
  });

  test.concurrent.each([
    ["https://bitbucket.org/acme/repo"],
    ["https://bitbucket.org/acme/repo.git"],
    ["https://jdoe:atl_secret@bitbucket.org/acme/repo.git"],
    ["https://jdoe@bitbucket.org/acme/repo.git"],
    ["ssh://git@bitbucket.org/acme/repo.git"],
    ["git@bitbucket.org:acme/repo.git"],
    ["https://BitBucket.ORG/acme/repo"],
  ])("%s is the bitbucket acme/repo", (input) => {
    expect(parseGitHost(input)).toEqual(acmeBitbucket);
  });

  test.concurrent("keeps the path casing the URL uses", () => {
    expect(parseGitHost("git@GitHub.com:Acme/Repo.git")).toEqual({
      host: "github",
      owner: "Acme",
      name: "Repo",
      webUrl: "https://github.com/Acme/Repo",
    });
    expect(parseGitHost("https://bitbucket.org/Acme/Repo")).toEqual({
      host: "bitbucket",
      workspace: "Acme",
      slug: "Repo",
      webUrl: "https://bitbucket.org/Acme/Repo",
    });
  });

  test.concurrent("never puts credentials in webUrl", () => {
    const result = parseGitHost(
      "https://user:ghp_secret@github.com/acme/repo.git",
    );
    expect(result.host === "other" ? null : result.webUrl).toBe(
      "https://github.com/acme/repo",
    );
  });

  test.concurrent.each([
    ["https://github.com:8443/acme/repo.git"],
    ["ssh://git@bitbucket.org:7999/acme/repo.git"],
    ["https://github.com/acme/repo/tree/main"],
    ["https://bitbucket.org/acme/team/repo"],
    ["https://github.com/acme"],
    ["https://bitbucket.org/acme"],
    ["https://github.com/"],
    ["https://gitlab.com/acme/repo.git"],
    ["git@gitlab.com:acme/repo.git"],
    ["https://github.example.com/acme/repo.git"],
    ["https://bitbucket.example.com/scm/acme/repo.git"],
    ["https://www.github.com/acme/repo"],
    ["file:///home/me/repo"],
    ["file://github.com/acme/repo"],
    ["/home/me/repo"],
    ["./repo"],
    ["C:/code/repo"],
    [""],
    ["not a url"],
  ])("%s is other", (input) => {
    expect(parseGitHost(input)).toEqual({ host: "other" });
  });
});
