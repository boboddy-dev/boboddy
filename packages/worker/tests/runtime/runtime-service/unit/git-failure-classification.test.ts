/**
 * Table tests for {@link isRepoCorruption}: stderr captured from real git
 * failures, split into "the local mirror is damaged" (heal by recreating) and
 * everything else (network, auth, remote problems: never delete a mirror).
 */
import { describe, expect, test } from "bun:test";
import { isRepoCorruption } from "../../../../src/runtime/runtime-service/infra/git-failure";

const CORRUPTION: Array<[string, string]> = [
  ["not a repository", "fatal: not a git repository: '/cache/ab12.git'"],
  [
    "not a repository (discovery form)",
    "fatal: not a git repository (or any of the parent directories): .git",
  ],
  [
    "corrupt loose object",
    [
      "error: inflate: data stream error (incorrect header check)",
      "error: unable to unpack ea19ff781afc6e679db1f70026673cca4474f3b3 header",
      "fatal: loose object ea19ff781afc6e679db1f70026673cca4474f3b3 (stored in m.git/objects/ea/19ff) is corrupt",
      "error: /tmp/remote.git did not send all necessary objects",
    ].join("\n"),
  ],
  [
    "bad ref target",
    [
      "fatal: bad object refs/heads/main",
      "error: /tmp/remote.git did not send all necessary objects",
    ].join("\n"),
  ],
  [
    "bad tree object",
    "fatal: bad tree object 8958ec7c1f1ee0b2b3d7f5b0b5d7b3f6b0d0b0aa",
  ],
  [
    "empty object file",
    "error: object file m.git/objects/ab/cdef is empty\nfatal: loose object abcdef is corrupt",
  ],
  [
    "invalid packfile",
    "error: file m.git/objects/pack/pack-1.pack is not a GIT packfile",
  ],
  [
    "ref to a missing object",
    "error: refs/heads/main does not point to a valid object!",
  ],
];

const NOT_CORRUPTION: Array<[string, string]> = [
  ["empty stderr", ""],
  [
    "remote path is not a repository",
    "fatal: '/tmp/remote.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
  ],
  [
    "could not resolve host",
    "fatal: unable to access 'https://example.com/x.git/': Could not resolve host: example.com",
  ],
  [
    "connection refused",
    "ssh: connect to host 127.0.0.1 port 1: Connection refused\nfatal: Could not read from remote repository.",
  ],
  [
    "connection timed out",
    "fatal: unable to access 'https://example.com/x.git/': Failed to connect to example.com port 443: Connection timed out",
  ],
  [
    "authentication failed",
    "fatal: Authentication failed for 'https://example.com/x.git/'",
  ],
  [
    "repository not found",
    "remote: Repository not found.\nfatal: repository 'https://example.com/x.git/' not found",
  ],
  [
    "permission denied (publickey)",
    "git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
  ],
  [
    "early EOF during transfer",
    "error: RPC failed; curl 18 transfer closed\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output",
  ],
  [
    "corruption reported by the remote side",
    "remote: error: object abcdef is corrupt\nfatal: Could not read from remote repository.",
  ],
  [
    "dubious ownership",
    "fatal: detected dubious ownership in repository at '/cache/ab12.git'",
  ],
  [
    "network error that also mentions a bad object on the remote",
    "fatal: unable to access 'https://example.com/x.git/': Could not resolve host: example.com\nfatal: bad object",
  ],
];

describe("isRepoCorruption", () => {
  for (const [name, stderr] of CORRUPTION) {
    test.concurrent(`classifies "${name}" as repo corruption`, () => {
      expect(isRepoCorruption(stderr)).toBe(true);
    });
  }

  for (const [name, stderr] of NOT_CORRUPTION) {
    test.concurrent(`does not classify "${name}" as repo corruption`, () => {
      expect(isRepoCorruption(stderr)).toBe(false);
    });
  }
});
