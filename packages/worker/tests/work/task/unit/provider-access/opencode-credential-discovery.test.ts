import { Writable } from "node:stream";
import { describe, expect, test } from "bun:test";
import pino from "pino";
import { listOpencodeAuthProviders } from "../../../../../src/work/task/infra/provider-access/opencode-credential-discovery";
import type {
  LoadOpencodeCredentialsInput,
  OpencodeCredential,
} from "../../../../../src/runtime/runtime-service/infra/opencode-credential-source";

/** Build a pino logger that captures log lines into an array. */
function makeCapturingLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { logger: pino({ level: "warn" }, stream), lines };
}

function oauth(integrationID: string, expires: number): OpencodeCredential {
  return {
    integrationID,
    source: "export",
    value: {
      type: "oauth",
      methodID: "oauth",
      access: "oat-secret",
      refresh: "ort-secret",
      expires,
    },
  };
}

function key(integrationID: string): OpencodeCredential {
  return {
    integrationID,
    source: "auth.json",
    value: { type: "key", key: "sk-secret" },
  };
}

function loaderReturning(
  credentials: OpencodeCredential[],
  calls: LoadOpencodeCredentialsInput[] = [],
): (input: LoadOpencodeCredentialsInput) => Promise<OpencodeCredential[]> {
  return (input) => {
    calls.push(input);
    return Promise.resolve(credentials);
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("listOpencodeAuthProviders", () => {
  test("returns sorted, de-duplicated integration ids only", async () => {
    const providers = await listOpencodeAuthProviders({
      loadCredentials: loaderReturning([
        key("openai"),
        oauth("anthropic", 0),
        key("anthropic"),
      ]),
    });

    expect(providers).toEqual(["anthropic", "openai"]);
    expect(JSON.stringify(providers)).not.toContain("secret");
  });

  test("forwards launcher, home and env to the credential loader", async () => {
    const calls: LoadOpencodeCredentialsInput[] = [];
    const env = { PATH: "/bin" };

    await listOpencodeAuthProviders({
      launcherPath: "/runtime/launch.sh",
      homeDir: "/tmp/home",
      env,
      loadCredentials: loaderReturning([], calls),
    });

    expect(calls[0]?.launcherPath).toBe("/runtime/launch.sh");
    expect(calls[0]?.homeDir).toBe("/tmp/home");
    expect(calls[0]?.env).toBe(env);
  });

  test("lists an expired OAuth credential but warns without leaking tokens", async () => {
    const { logger, lines } = makeCapturingLogger();

    const providers = await listOpencodeAuthProviders({
      logger,
      loadCredentials: loaderReturning([oauth("anthropic", Date.now() - 1000)]),
    });

    expect(providers).toEqual(["anthropic"]);
    await flush();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "") as { level: number; msg: string };
    expect(parsed.level).toBe(40);
    expect(parsed.msg).toContain("anthropic");
    expect(lines[0]).not.toContain("oat-secret");
    expect(lines[0]).not.toContain("ort-secret");
  });

  test("does not warn for an OAuth credential with no stored expiry", async () => {
    const { logger, lines } = makeCapturingLogger();

    await listOpencodeAuthProviders({
      logger,
      loadCredentials: loaderReturning([oauth("anthropic", 0)]),
    });

    await flush();
    expect(lines).toHaveLength(0);
  });

  test("routes loader warnings to the logger at warn", async () => {
    const { logger, lines } = makeCapturingLogger();

    await listOpencodeAuthProviders({
      logger,
      loadCredentials: (input) => {
        input.onWarning?.("export failed");
        return Promise.resolve([]);
      },
    });

    await flush();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("export failed");
  });
});
