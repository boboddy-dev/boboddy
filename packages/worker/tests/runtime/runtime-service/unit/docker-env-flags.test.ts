import { describe, expect, test } from "bun:test";
import { buildDockerEnvFlags } from "../../../../src/runtime/runtime-service/infra/docker-env-flags";

describe("buildDockerEnvFlags", () => {
  test.concurrent("expands each entry into a -e KEY=VALUE pair", () => {
    expect(
      buildDockerEnvFlags({ ACCOUNT_ID: "acct-1", LOG_LEVEL: "info" }),
    ).toEqual(["-e", "ACCOUNT_ID=acct-1", "-e", "LOG_LEVEL=info"]);
  });

  test.concurrent("returns no flags for an empty env", () => {
    expect(buildDockerEnvFlags({})).toEqual([]);
  });

  test.concurrent(
    "passes values through verbatim, with no shell quoting",
    () => {
      expect(
        buildDockerEnvFlags({
          URL: "https://x.example.com/?a=b&c=d",
          SPACED: "two words",
          QUOTED: `it's "quoted" $HOME`,
          EMPTY: "",
          MULTILINE: "line1\nline2",
        }),
      ).toEqual([
        "-e",
        "URL=https://x.example.com/?a=b&c=d",
        "-e",
        "SPACED=two words",
        "-e",
        `QUOTED=it's "quoted" $HOME`,
        "-e",
        "EMPTY=",
        "-e",
        "MULTILINE=line1\nline2",
      ]);
    },
  );

  test.concurrent(
    "concatenated layers keep their order so later flags win",
    () => {
      expect([
        ...buildDockerEnvFlags({ TOKEN: "provider" }),
        ...buildDockerEnvFlags({ TOKEN: "step" }),
      ]).toEqual(["-e", "TOKEN=provider", "-e", "TOKEN=step"]);
    },
  );
});
