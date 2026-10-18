import { describe, expect, test } from "bun:test";
import {
  compileMcps,
  defineMcp,
  resolveMcpChecks,
  type McpHandle,
} from "../src";

const tch = defineMcp({
  type: "ref",
  name: "tch",
  env: ["TICKET_NUMBER"],
  healthChecks: {
    operatorCreds: { tool: "fetch_operator_credentials", timeoutSeconds: 30 },
    resolveUsers: { tool: "fetch_user_ids", args: { emails: ["a@x.test"] } },
    impersonate: { tool: "impersonate", enabled: false },
  },
});

function state(handle: McpHandle) {
  return Object.fromEntries(
    resolveMcpChecks(handle).map(({ name, check, enabled }) => [
      name,
      { ...check, enabled },
    ]),
  );
}

describe("defineMcp — immutability", () => {
  test("chains off a shared handle never change it or each other", () => {
    const before = state(tch);
    const left = tch
      .disableCheck("operatorCreds")
      .overrideCheck("resolveUsers", { args: { emails: ["left@x.test"] } })
      .addCheck("studio", { tool: "debug_studio_status" });
    const right = tch
      .enableCheck("impersonate")
      .overrideCheck("resolveUsers", { timeoutSeconds: 5 });

    expect(state(tch)).toEqual(before);
    expect(tch.overrides).toEqual([]);

    expect(state(left).operatorCreds?.enabled).toBe(false);
    expect(state(left).resolveUsers?.args).toEqual({
      emails: ["left@x.test"],
    });
    expect(state(left).impersonate?.enabled).toBe(false);

    expect(state(right).operatorCreds?.enabled).toBe(true);
    expect(state(right).impersonate?.enabled).toBe(true);
    expect(state(right).resolveUsers).toMatchObject({
      args: { emails: ["a@x.test"] },
      timeoutSeconds: 5,
    });
    expect(state(right).studio).toBeUndefined();
  });

  test("handles and their data are frozen", () => {
    const next = tch.overrideCheck("resolveUsers", { args: { a: 1 } });
    for (const handle of [tch, next]) {
      expect(Object.isFrozen(handle)).toBe(true);
      expect(Object.isFrozen(handle.checks)).toBe(true);
      expect(Object.isFrozen(handle.checks["resolveUsers"])).toBe(true);
      expect(Object.isFrozen(handle.env)).toBe(true);
      expect(Object.isFrozen(handle.overrides)).toBe(true);
    }
    expect(Object.isFrozen(next.overrides[0])).toBe(true);
  });

  test("an inline server's fields are frozen and copied from the config", () => {
    const command = ["run-it", "--flag"];
    const environment = { TOKEN: "{env:TOKEN}" };
    const local = defineMcp({
      type: "local",
      name: "svc",
      command,
      environment,
    });
    command.push("--late");
    environment.TOKEN = "{env:OTHER}";
    const next = local.addCheck("ping", { tool: "ping" });
    for (const handle of [local, next]) {
      expect(handle.type).toBe("local");
      expect(handle.name).toBe("svc");
      expect(handle.server).toEqual({
        command: ["run-it", "--flag"],
        environment: { TOKEN: "{env:TOKEN}" },
      });
      expect(Object.isFrozen(handle.server)).toBe(true);
      if (handle.type === "local") {
        expect(Object.isFrozen(handle.server.command)).toBe(true);
        expect(Object.isFrozen(handle.server.environment)).toBe(true);
      }
    }
  });

  test("mutating the authored config afterwards does not leak in", () => {
    const checks = { ping: { tool: "ping", args: { n: 1 } } };
    const env = ["API_KEY"];
    const handle = defineMcp({
      type: "ref",
      name: "svc",
      env,
      healthChecks: checks,
    });
    checks.ping.args.n = 2;
    env.push("OTHER");
    expect(handle.checks["ping"]?.args).toEqual({ n: 1 });
    expect(handle.env).toEqual(["API_KEY"]);
  });
});

describe("defineMcp — D12 precedence", () => {
  test("disableCheck wins over overrideCheck in either order", () => {
    const disableFirst = tch
      .disableCheck("resolveUsers")
      .overrideCheck("resolveUsers", { timeoutSeconds: 1 });
    const overrideFirst = tch
      .overrideCheck("resolveUsers", { timeoutSeconds: 1 })
      .disableCheck("resolveUsers");
    for (const handle of [disableFirst, overrideFirst]) {
      expect(state(handle).resolveUsers).toMatchObject({
        enabled: false,
        timeoutSeconds: 1,
      });
    }
  });

  test("between enable and disable, the last call wins", () => {
    expect(
      state(tch.enableCheck("impersonate").disableCheck("impersonate"))
        .impersonate?.enabled,
    ).toBe(false);
    expect(
      state(tch.disableCheck("operatorCreds").enableCheck("operatorCreds"))
        .operatorCreds?.enabled,
    ).toBe(true);
  });

  test("later overrides of the same field win; other fields accumulate", () => {
    const handle = tch
      .overrideCheck("operatorCreds", { timeoutSeconds: 10, severity: "warn" })
      .overrideCheck("operatorCreds", { timeoutSeconds: 20 });
    expect(state(handle).operatorCreds).toMatchObject({
      tool: "fetch_operator_credentials",
      timeoutSeconds: 20,
      severity: "warn",
    });
  });

  test("args are replaced whole, not merged", () => {
    const handle = tch
      .overrideCheck("resolveUsers", { args: { emails: ["b@x.test"], x: 1 } })
      .overrideCheck("resolveUsers", { args: { other: true } });
    expect(state(handle).resolveUsers?.args).toEqual({ other: true });
  });

  test("disableAllChecks disables every known check; later enable/add turn checks on", () => {
    const handle = tch
      .disableAllChecks()
      .enableCheck("resolveUsers")
      .addCheck("studio", { tool: "debug_studio_status" });
    const resolved = state(handle);
    expect(resolved.operatorCreds?.enabled).toBe(false);
    expect(resolved.impersonate?.enabled).toBe(false);
    expect(resolved.resolveUsers?.enabled).toBe(true);
    expect(resolved.studio?.enabled).toBe(true);
  });

  test("a check added disabled can be enabled later", () => {
    const handle = tch
      .addCheck("studio", { tool: "s", enabled: false })
      .enableCheck("studio");
    expect(state(handle).studio?.enabled).toBe(true);
  });
});

describe("defineMcp — names and validation", () => {
  test("addCheck with an existing name throws", () => {
    expect(() =>
      // @ts-expect-error an existing check name is rejected by the type
      tch.addCheck("operatorCreds", { tool: "x" }),
    ).toThrow(/already exists/);
    const added = tch.addCheck("studio", { tool: "s" });
    // @ts-expect-error a name from an earlier addCheck is rejected too
    expect(() => added.addCheck("studio", { tool: "s" })).toThrow(
      /already exists/,
    );
  });

  test("unknown names throw at runtime and fail typecheck", () => {
    // @ts-expect-error unknown check name
    expect(() => tch.disableCheck("nope")).toThrow(
      /unknown health check "nope"/,
    );
    // @ts-expect-error unknown check name
    expect(() => tch.enableCheck("nope")).toThrow(/unknown/);
    expect(() =>
      // @ts-expect-error unknown check name
      tch.overrideCheck("nope", { timeoutSeconds: 1 }),
    ).toThrow(/unknown/);
  });

  test("an addCheck name is usable by later builder calls", () => {
    const handle = tch
      .addCheck("studio", { tool: "debug_studio_status" })
      .overrideCheck("studio", { timeoutSeconds: 3 })
      .disableCheck("studio");
    expect(state(handle).studio).toMatchObject({
      tool: "debug_studio_status",
      timeoutSeconds: 3,
      enabled: false,
    });
  });

  test("rejects bad check names, env names, and check fields", () => {
    expect(() =>
      defineMcp({
        type: "ref",
        name: "x",
        healthChecks: { "a.b": { tool: "t" } },
      }),
    ).toThrow(/no "\."/);
    expect(() =>
      defineMcp({
        type: "ref",
        name: "x",
        healthChecks: { "": { tool: "t" } },
      }),
    ).toThrow(/non-empty/);
    expect(() => tch.addCheck("a.b", { tool: "t" })).toThrow(/no "\."/);
    expect(() => defineMcp({ type: "ref", name: "x", env: ["lower"] })).toThrow(
      /must match/,
    );
    expect(() =>
      defineMcp({ type: "ref", name: "x", env: ["BOBODDY_TOKEN"] }),
    ).toThrow(/reserved/);
    expect(() =>
      defineMcp({ type: "ref", name: "x", optionalEnv: ["HOME"] }),
    ).toThrow(/reserved/);
    expect(() =>
      defineMcp({ type: "ref", name: "x", env: ["A"], optionalEnv: ["A"] }),
    ).toThrow(/more than once/);
    expect(() =>
      defineMcp({ type: "ref", name: "x", healthChecks: { c: { tool: "" } } }),
    ).toThrow(/health check "c"/);
    expect(() => defineMcp({ type: "ref", name: "" })).toThrow(/name/);
    expect(() =>
      tch.overrideCheck("operatorCreds", {
        ...({ mcp: "other" } as object),
      }),
    ).toThrow(/overrideCheck/);
  });
});

describe("compileMcps — severity and serialGroup", () => {
  const svc = defineMcp({
    type: "ref",
    name: "svc",
    healthChecks: {
      req: { tool: "a" },
      warn: { tool: "b", severity: "warn" },
      grouped: { tool: "c", serialGroup: "shared" },
    },
  });

  function severities(handle: McpHandle): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};
    for (const check of compileMcps({ svc: handle }, "step").healthChecks) {
      result[check.name ?? ""] = check.severity;
    }
    return result;
  }

  test("a check's own severity compiles as written; the default is required", () => {
    expect(severities(svc)).toEqual({
      "svc.req": "required",
      "svc.warn": "warn",
      "svc.grouped": "required",
    });
  });

  test("overrideCheck changes one check's severity per step", () => {
    expect(
      severities(
        svc
          .overrideCheck("req", { severity: "warn" })
          .overrideCheck("warn", { severity: "required" }),
      ),
    ).toEqual({
      "svc.req": "warn",
      "svc.warn": "required",
      "svc.grouped": "required",
    });
  });

  test("a handle has no server-level severity", () => {
    // @ts-expect-error severity is set per check, not on the handle
    expect(svc.severity).toBeUndefined();
    expect("serverSeverity" in svc).toBe(false);
  });

  test("serialGroup defaults to the step key; an explicit one wins (D13)", () => {
    const { healthChecks } = compileMcps({ alias: svc }, "step");
    expect(
      healthChecks.map((check) => [check.name, check.serialGroup]),
    ).toEqual([
      ["alias.req", "alias"],
      ["alias.warn", "alias"],
      ["alias.grouped", "shared"],
    ]);
  });

  test("rejects values that are not defineMcp handles", () => {
    expect(() => compileMcps({ fake: { ...svc } }, "step")).toThrow(
      /expected a handle from defineMcp/,
    );
  });
});
