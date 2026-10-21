import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger } from "../../src/logging";

const captureLines = () => {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { lines, dest };
};

describe("createLogger redaction", () => {
  test("censors secret values and API keys in logged request bodies", () => {
    const { lines, dest } = captureLines();
    const logger = createLogger({ name: "test" }, dest);

    logger.info(
      {
        body: { name: "Work Jira", value: "secret-token-1" },
        req: { body: { email: "me@example.com", apiKey: "secret-token-2" } },
        jiraCredential: { apiKey: "secret-token-3" },
      },
      "request",
    );

    const output = lines.join("");
    expect(output).not.toContain("secret-token");
    expect(output).toContain("Work Jira");
    expect(output).toContain("[REDACTED]");
  });

  test("censors pasted GitHub tokens and Bitbucket API tokens", () => {
    const { lines, dest } = captureLines();
    const logger = createLogger({ name: "test" }, dest);

    logger.info(
      {
        token: "secret-token-1",
        req: { body: { token: "secret-token-2" } },
        body: {
          credential: { email: "me@example.com", apiToken: "secret-token-3" },
        },
        bitbucketCredential: { apiToken: "secret-token-4" },
        githubCredential: { token: "secret-token-5" },
      },
      "request",
    );

    const output = lines.join("");
    expect(output).not.toContain("secret-token");
    expect(output).toContain("me@example.com");
  });

  test("censors a credential nested in a project's issue tracker", () => {
    const { lines, dest } = captureLines();
    const logger = createLogger({ name: "test" }, dest);

    logger.info(
      {
        req: {
          body: {
            gitUrl: "https://github.com/acme/repo.git",
            issueTracker: {
              type: "jira",
              credential: { email: "me@example.com", apiKey: "secret-token-1" },
            },
          },
        },
        body: {
          issueTracker: {
            type: "github_token",
            credential: { token: "secret-token-2" },
          },
        },
      },
      "request",
    );

    const output = lines.join("");
    expect(output).not.toContain("secret-token");
    expect(output).toContain("acme/repo");
  });
});
