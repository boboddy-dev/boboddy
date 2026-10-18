import { describe, expect, test } from "bun:test";
import type { ConfigEntry } from "@opencode/client";
import type { z } from "zod";
import {
  openCodeMcpServersSchema,
  openCodeResolvedMcpServersSchema,
  type openCodeMcpLocalConfigSchema,
  type openCodeMcpRemoteConfigSchema,
} from "../src/opencode-mcp";

type V2ConfigInfo = Extract<ConfigEntry, { type: "document" }>["info"];
type V2McpServer = NonNullable<
  NonNullable<V2ConfigInfo["mcp"]>["servers"]
>[string];

type OpenCodeMcpInlineServer =
  | z.infer<typeof openCodeMcpLocalConfigSchema>
  | z.infer<typeof openCodeMcpRemoteConfigSchema>;

type AssertAssignable<TSub extends TSuper, TSuper> = [TSub, TSuper];
type KeysOf<T> = T extends unknown ? keyof T : never;

export type ShapeChecks = [
  AssertAssignable<OpenCodeMcpInlineServer, V2McpServer>,
  AssertAssignable<KeysOf<V2McpServer>, KeysOf<OpenCodeMcpInlineServer>>,
];

const v2Entries = {
  playwright: {
    type: "local",
    command: ["npx", "-y", "@playwright/mcp@0.0.68"],
    disabled: false,
    codemode: false,
    timeout: { catalog: 30_000, execution: 60_000 },
  },
  linear: {
    type: "remote",
    url: "https://mcp.linear.app/sse",
    oauth: { client_id: "abc", redirect_uri: "http://localhost/cb" },
  },
};

const v1Entries = [
  { type: "local", command: ["x"], enabled: true },
  { type: "local", command: ["x"], timeout: 5000 },
  { type: "remote", url: "https://x", oauth: { clientId: "abc" } },
  { enabled: false },
];

describe("openCodeMcpServersSchema", () => {
  test("accepts the v2 local and remote entry shapes", () => {
    const parsed = openCodeMcpServersSchema.parse(v2Entries);
    expect(Object.keys(parsed)).toEqual(["playwright", "linear"]);
  });

  test("accepts ref entries", () => {
    const parsed = openCodeMcpServersSchema.parse({
      postgres: { type: "ref" },
      tch: { type: "ref", name: "x", codemode: true },
    });
    expect(parsed).toEqual({
      postgres: { type: "ref" },
      tch: { type: "ref", name: "x", codemode: true },
    });
  });

  test("rejects optional on ref, local and remote servers", () => {
    for (const entry of [
      { type: "ref", optional: true },
      { type: "local", command: ["x"], optional: true },
      { type: "remote", url: "https://x", optional: false },
    ]) {
      expect(
        openCodeMcpServersSchema.safeParse({ s: entry }).success,
        JSON.stringify(entry),
      ).toBe(false);
    }
  });

  test("rejects severity on a ref", () => {
    for (const severity of ["required", "warn"]) {
      expect(
        openCodeMcpServersSchema.safeParse({ s: { type: "ref", severity } })
          .success,
        severity,
      ).toBe(false);
    }
  });

  test("rejects a ref carrying definition fields", () => {
    expect(
      openCodeMcpServersSchema.safeParse({
        s: { type: "ref", command: ["npx", "x"] },
      }).success,
    ).toBe(false);
  });

  test("rejects v1 keys", () => {
    for (const legacy of v1Entries) {
      expect(
        openCodeMcpServersSchema.safeParse({ s: legacy }).success,
        JSON.stringify(legacy),
      ).toBe(false);
    }
  });
});

describe("openCodeResolvedMcpServersSchema", () => {
  test("accepts the v2 local and remote entry shapes", () => {
    const parsed = openCodeResolvedMcpServersSchema.parse(v2Entries);
    expect(Object.keys(parsed)).toEqual(["playwright", "linear"]);
  });

  test("rejects ref entries and v1 keys", () => {
    for (const entry of [{ type: "ref" }, ...v1Entries]) {
      expect(
        openCodeResolvedMcpServersSchema.safeParse({ s: entry }).success,
        JSON.stringify(entry),
      ).toBe(false);
    }
  });
});
