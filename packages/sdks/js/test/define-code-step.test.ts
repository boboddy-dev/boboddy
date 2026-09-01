import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { codeStep } from "../src/definitions/steps/define-code-step";

describe("codeStep", () => {
  test.concurrent("produces a kind: 'code' spec with no prompt and a live entrypoint.fn", () => {
    const fn = (input: { path: string }) => ({ ok: true, path: input.path });
    const spec = codeStep({
      key: "read-file",
      name: "Read File",
      version: 2,
      fn,
      inputSchema: z.object({ path: z.string() }),
      resultSchema: z.object({ ok: z.boolean(), path: z.string() }),
      signals: [{ sourcePath: "ok", type: "boolean" }],
    });

    expect(spec.kind).toBe("code");
    expect(spec.prompt).toBeNull();
    expect(spec.version).toBe(2);
    expect(spec.entrypoint?.fn === fn).toBe(true);
    expect(spec.entrypointJson).toBeUndefined();
    expect(spec.inputSchemaJson).toMatchObject({ type: "object" });
    expect(spec.resultSchemaJson).toMatchObject({ type: "object" });
    expect(spec.signalExtractorDefinitions).toEqual([
      {
        key: "ok",
        sourcePath: "ok",
        type: "boolean",
        required: true,
        availableWhenResultStatusIn: null,
      },
    ]);
  });

  test.concurrent("defaults version to 1 and status to active", () => {
    const spec = codeStep({
      key: "noop",
      name: "Noop",
      fn: () => ({}),
    });
    expect(spec.version).toBe(1);
    expect(spec.status).toBe("active");
  });
});
