import { describe, expect, test } from "bun:test";
import { compileMcps, defineMcp } from "../src";

describe("defineMcp — inline servers", () => {
  test("rejects a literal environment value (E3)", () => {
    expect(() =>
      defineMcp({
        type: "local",
        name: "db",
        command: ["db-mcp"],
        environment: { DATABASE_URL: "postgres://user:pw@host/db" },
      }),
    ).toThrow(
      /defineMcp "db": environment\.DATABASE_URL must be written as \{env:VAR\}/,
    );
  });

  test("rejects a literal header value (E3)", () => {
    expect(() =>
      defineMcp({
        type: "remote",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer lin_api_123" },
      }),
    ).toThrow(
      /defineMcp "linear": headers\.Authorization must be written as \{env:VAR\}/,
    );
  });

  test("accepts {env:VAR} values, with an auth scheme prefix", () => {
    expect(() =>
      defineMcp({
        type: "remote",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer {env:LINEAR_API_KEY}" },
      }),
    ).not.toThrow();
  });

  test("rejects invalid server fields with the server's name", () => {
    expect(() =>
      defineMcp({ type: "local", name: "svc", command: [] }),
    ).toThrow(/defineMcp "svc": command/);
    expect(() =>
      defineMcp({
        type: "remote",
        name: "svc",
        url: "https://x.test",
        ...({ command: ["x"] } as object),
      }),
    ).toThrow(/defineMcp "svc"/);
    expect(() =>
      defineMcp({
        type: "local",
        name: "svc",
        command: ["x"],
        ...({ optional: true } as object),
      }),
    ).toThrow(/defineMcp "svc"/);
    expect(() =>
      defineMcp({ type: "stdio", name: "svc" } as unknown as Parameters<
        typeof defineMcp
      >[0]),
    ).toThrow(/type must be "ref", "local" or "remote"/);
  });

  test("rejects a placeholder naming a reserved variable", () => {
    expect(() =>
      defineMcp({
        type: "local",
        name: "svc",
        command: ["x"],
        environment: { T: "{env:BOBODDY_TOKEN}" },
      }),
    ).toThrow(/reserved/);
  });
});

describe("compileMcps — server types", () => {
  const inherit = (name: string, optional: boolean, mcp: string) => ({
    source: "inherit" as const,
    name,
    from: name,
    secret: true,
    optional,
    mcp,
    applies: "agent" as const,
  });

  test("each type compiles to its wire entry", () => {
    const ref = defineMcp({
      type: "ref",
      name: "postgres",
      timeout: { startup: 5000 },
    });
    const local = defineMcp({
      type: "local",
      name: "playwright",
      command: ["npx", "-y", "@playwright/mcp", "--headless"],
      cwd: "/tmp",
      codemode: true,
    });
    const remote = defineMcp({
      type: "remote",
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      oauth: false,
      protocol: "auto",
    });
    expect(
      compileMcps({ db: ref, playwright: local, linear: remote }, "step")
        .opencodeMcpJson,
    ).toEqual({
      db: { type: "ref", name: "postgres", timeout: { startup: 5000 } },
      playwright: {
        type: "local",
        command: ["npx", "-y", "@playwright/mcp", "--headless"],
        cwd: "/tmp",
        codemode: true,
      },
      linear: {
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        oauth: false,
        protocol: "auto",
      },
    });
  });

  test("infers required vars from environment, command and cwd (E4)", () => {
    const local = defineMcp({
      type: "local",
      name: "svc",
      command: ["svc-mcp", "--region={env:REGION}"],
      cwd: "{env:SVC_HOME}/bin",
      environment: { TOKEN: "{env:SVC_TOKEN}" },
      optionalEnv: ["SVC_HOME"],
    });
    expect(compileMcps({ svc: local }, "step").envEntries).toEqual([
      inherit("REGION", false, "svc"),
      inherit("SVC_TOKEN", false, "svc"),
      inherit("SVC_HOME", true, "svc"),
    ]);
  });

  test("infers required vars from url and headers (E4)", () => {
    const remote = defineMcp({
      type: "remote",
      name: "api",
      url: "https://{env:API_HOST}/mcp",
      headers: { Authorization: "Bearer {env:API_TOKEN}" },
      env: ["API_TOKEN"],
    });
    expect(compileMcps({ api: remote }, "step").envEntries).toEqual([
      inherit("API_TOKEN", false, "api"),
      inherit("API_HOST", false, "api"),
    ]);
  });

  test("a warn check on an inline server leaves the server and its vars as authored", () => {
    const local = defineMcp({
      type: "local",
      name: "playwright",
      command: ["pw-mcp"],
      environment: { BROWSERS: "{env:PLAYWRIGHT_BROWSERS_PATH}" },
      healthChecks: {
        navigate: { tool: "browser_navigate" },
        snapshot: { tool: "browser_snapshot", severity: "warn" },
      },
    }).overrideCheck("navigate", { severity: "warn" });
    const compiled = compileMcps({ pw: local }, "step");
    expect(compiled.opencodeMcpJson).toEqual({
      pw: {
        type: "local",
        command: ["pw-mcp"],
        environment: { BROWSERS: "{env:PLAYWRIGHT_BROWSERS_PATH}" },
      },
    });
    expect(compiled.healthChecks).toEqual([
      {
        kind: "tool",
        mcp: "pw",
        name: "pw.navigate",
        tool: "browser_navigate",
        serialGroup: "pw",
        severity: "warn",
      },
      {
        kind: "tool",
        mcp: "pw",
        name: "pw.snapshot",
        tool: "browser_snapshot",
        serialGroup: "pw",
        severity: "warn",
      },
    ]);
    expect(compiled.envEntries).toEqual([
      inherit("PLAYWRIGHT_BROWSERS_PATH", false, "pw"),
    ]);
  });
});
