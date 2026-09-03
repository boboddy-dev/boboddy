import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { codeStep } from "../src/definitions/steps/define-code-step";
import { Features, Notify } from "../src/definitions/steps/step-features";

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

  describe("features", () => {
    test.concurrent(
      "features: [Features.notifications()] wires the result field and signal without a prompt",
      () => {
        const spec = codeStep({
          key: "notify",
          name: "Notify",
          features: [Features.notifications()],
          fn: () => Notify.inApp("Title", "This is the comment", "high"),
        });

        expect(spec.kind).toBe("code");
        expect(spec.prompt).toBeNull();
        expect(spec.resultSchemaJson).toMatchObject({
          properties: { $boboddy_notifications_v1: { type: "array" } },
        });
        expect(spec.signalExtractorDefinitions).toContainEqual({
          key: "$boboddy_notifications_v1",
          sourcePath: "$boboddy_notifications_v1",
          type: "array",
          required: false,
          availableWhenResultStatusIn: null,
        });
      },
    );

    test.concurrent(
      "Notify.inApp(...) builds a single in-app-suggested notification",
      () => {
        const result = Notify.inApp("Title", "This is the comment", "high");
        expect(result).toEqual({
          $boboddy_notifications_v1: [
            {
              kind: "status_update",
              title: "Title",
              body: "This is the comment",
              priority: "high",
              suggestedChannels: ["in_app"],
            },
          ],
        });
      },
    );

    test.concurrent("Notify.inApp(...) accepts an explicit kind and payload", () => {
      const result = Notify.inApp("Blocked", "Need input", "urgent", {
        kind: "blocked",
        payload: { category: "infra" },
      });
      expect(result.$boboddy_notifications_v1[0]).toMatchObject({
        kind: "blocked",
        suggestedChannels: ["in_app"],
        payload: { category: "infra" },
      });
    });

    test.concurrent("Notify.create(...) suggests any channel directly, without dedicated sugar", () => {
      const result = Notify.create({
        kind: "status_update",
        title: "Deployed",
        body: "v2.3.0 is live",
        priority: "normal",
        suggestedChannels: ["slack"],
      });
      expect(result.$boboddy_notifications_v1[0]).toMatchObject({
        suggestedChannels: ["slack"],
      });
    });

    test.concurrent("Notify.merge(...) combines fragments from multiple calls", () => {
      const result = Notify.merge(
        Notify.inApp("A", "a", "low"),
        Notify.create({
          kind: "status_update",
          title: "B",
          body: "b",
          priority: "normal",
          suggestedChannels: ["email"],
        }),
      );
      expect(result.$boboddy_notifications_v1).toHaveLength(2);
      expect(result.$boboddy_notifications_v1.map((n) => n.suggestedChannels)).toEqual(
        [["in_app"], ["email"]],
      );
    });

    test.concurrent(
      "a resultSchema declared alongside features merges into one JSON schema",
      () => {
        const spec = codeStep({
          key: "notify-with-status",
          name: "Notify With Status",
          resultSchema: z.object({ status: z.literal("completed") }),
          features: [Features.notifications()],
          fn: () => ({
            status: "completed" as const,
            ...Notify.inApp("Done", "All finished", "normal"),
          }),
        });

        expect(spec.resultSchemaJson).toMatchObject({
          properties: {
            status: { const: "completed" },
            $boboddy_notifications_v1: { type: "array" },
          },
        });
      },
    );
  });
});
