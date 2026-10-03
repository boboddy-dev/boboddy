import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Repo, codeStep } from "../src";

describe("codeStep — repo", () => {
  const base = { key: "c", name: "C" } as const;

  test("omitted repo emits no repo field", () => {
    const spec = codeStep({ ...base, fn: () => ({}) });
    expect("repo" in spec).toBe(false);
  });

  test("static and function forms compile, with result typed from resultSchema", () => {
    const readOnly = codeStep({
      ...base,
      fn: () => ({}),
      environment: { repo: Repo.readOnly() },
    });
    const readWrite = codeStep({
      ...base,
      inputSchema: z.object({ ticket: z.string() }),
      resultSchema: z.object({ summary: z.string() }),
      fn: () => ({ summary: "done" }),
      environment: {
        repo: ({ input, result }) =>
          Repo.readWrite({ message: `${input.ticket}: ${result.summary}` }),
      },
    });
    expect(readOnly.repo).toEqual({ mode: "readOnly" });
    expect(readWrite.repo).toEqual({
      mode: "readWrite",
      message: "{{input.ticket}}: {{result.summary}}",
    });
  });

  test("Repo.none() is a type error and throws", () => {
    expect(() =>
      codeStep({
        ...base,
        fn: () => ({}),
        // @ts-expect-error a code step needs a workspace, and none has no clone
        environment: { repo: Repo.none() },
      }),
    ).toThrow(/Step "c" repo "none"/);
  });
});
