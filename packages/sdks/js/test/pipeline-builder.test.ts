import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  pipeline,
  PipelineBuilder,
  PipelineStepAdvancementBuilder,
  PipelineStepBuilder,
} from "../src/definitions/pipelines/builder";
import { defineStep } from "../src/definitions/steps/define-step";

const noInputStep = defineStep({
  key: "no-input",
  name: "No Input Step",
  agentPrompt: "Do the work.",
  input: z.object({}),
  result: z.object({}),
  signals: [],
});

const reproduceStep = defineStep({
  key: "reproduce",
  name: "Reproduce Issue",
  agentPrompt:
    "Reproduce the following issue using the provided title and description.",
  input: z.object({ title: z.string(), description: z.string() }),
  result: z.object({
    url: z.string(),
    success: z.boolean(),
    verified: z.boolean(),
    score: z.number(),
    score2: z.number(),
  }),
  signals: [
    { sourcePath: "url", key: "repro_url" },
    { sourcePath: "success" },
    { sourcePath: "verified" },
    { sourcePath: "score" },
    { sourcePath: "score2" },
  ],
});

const verifyStep = defineStep({
  key: "verify",
  name: "Verify Fix",
  agentPrompt: "Verify whether the fix passes using the provided inputs.",
  input: z.object({
    reproUrl: z.string(),
    checkSuccess: z.boolean(),
    fullPrior: z.object({ url: z.string(), success: z.boolean() }),
  }),
  result: z.object({ passed: z.boolean() }),
  signals: [{ sourcePath: "passed" }],
});

const enrichedStep = defineStep({
  key: "enriched",
  name: "Enriched Step",
  agentPrompt: "Use the bound metadata fields to produce the result.",
  input: z.object({
    jiraProject: z.string().nullable().optional(),
    owner: z.string().optional(),
    priority: z.string().nullable().optional(),
  }),
  additionalStepInput: {
    schema: z.object({
      jiraProject: z.string().nullable(),
      owner: z.string(),
    }),
    bindings: ({ workItemField, literal }) => ({
      jiraProject: workItemField("Jira Project"),
      owner: literal("platform-team"),
    }),
  },
  result: z.object({ ok: z.boolean() }),
  signals: [{ sourcePath: "ok" }],
});

describe("pipeline() builder — Phase 1", () => {
  test.concurrent("pipeline() returns a PipelineBuilder", () => {
    const builder = pipeline({ key: "p", name: "P" });

    expect(builder).toBeInstanceOf(PipelineBuilder);
  });

  test.concurrent(
    "build() carries explicit description, version, status",
    () => {
      const spec = pipeline({
        key: "p",
        name: "P",
        description: "does stuff",
        version: 3,
        status: "draft",
      })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      expect(spec.description).toBe("does stuff");
      expect(spec.version).toBe(3);
      expect(spec.status).toBe("draft");
    },
  );
});

describe("pipeline() builder — .step() (Phase 3)", () => {
  test.concurrent(".step() returns a PipelineStepAdvancementBuilder", () => {
    const builder = pipeline({ key: "p", name: "P" }).step(
      reproduceStep,
      ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }),
    );

    expect(builder).toBeInstanceOf(PipelineStepAdvancementBuilder);
  });

  test.concurrent(".advance() returns a PipelineStepBuilder", () => {
    const builder = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      .advance(() => ({ default: "continue" }));

    expect(builder).toBeInstanceOf(PipelineStepBuilder);
  });

  test.concurrent(
    "multi-step pipeline: signal and output bindings serialize correctly",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .step(verifyStep, ({ signal, output }) => ({
          reproUrl: signal(reproduceStep, "repro_url"),
          checkSuccess: signal(reproduceStep, "success"),
          fullPrior: output(reproduceStep),
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      expect(spec.steps[1]!.inputBindingsJson).toMatchObject({
        reproUrl: {
          source: "step_signal",
          stepKey: "reproduce",
          signalKey: "repro_url",
        },
        checkSuccess: {
          source: "step_signal",
          stepKey: "reproduce",
          signalKey: "success",
        },
        fullPrior: { source: "step_output", stepKey: "reproduce" },
      });
    },
  );

  test.concurrent(
    "_stepDefinitions accumulates referenced step specs deduped",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .step(verifyStep, ({ signal, output }) => ({
          reproUrl: signal(reproduceStep, "repro_url"),
          checkSuccess: signal(reproduceStep, "success"),
          fullPrior: output(reproduceStep),
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      const keys = (spec._stepDefinitions ?? []).map((s) => s.key);
      expect(keys.sort()).toEqual(["reproduce", "verify"]);
    },
  );
});

describe("pipeline() builder — .advance() (Phase 4)", () => {
  test.concurrent("all-group with route outcome serializes correctly", () => {
    const spec = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      .advance(({ signal, all, route }) => ({
        default: "complete",
        rules: [
          all(
            signal("success").eq(true),
            signal("repro_url").eq("https://x"),
          ).then(route("downstream", { ok: true })),
        ],
      }))
      .build();

    const rule = spec.steps[0]!.advancementPolicyDefinition.rulesJson.rules[0]!;
    expect(rule.conditions).toMatchObject({
      all: [
        { fact: "success", operator: "equal", value: true },
        { fact: "repro_url", operator: "equal", value: "https://x" },
      ],
    });
    expect(rule.event).toMatchObject({
      type: "route",
      params: { pipelineKey: "downstream", inputJson: { ok: true } },
    });
  });

  test.concurrent(
    "computed rule (avg) hoists into computedSignalDefinitions",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(({ avg, stepSignals }) => ({
          default: "complete",
          rules: [
            avg(stepSignals.score, stepSignals.score2)
              .gte(0.5)
              .then("continue"),
          ],
        }))
        .build();

      expect(spec.steps[0]!.computedSignalDefinitions).toEqual([
        {
          key: "average_score_score2",
          type: "average",
          inputSignalKeys: ["score", "score2"],
          configJson: null,
          availableWhenResultStatusIn: null,
        },
      ]);
      expect(
        spec.steps[0]!.advancementPolicyDefinition.rulesJson.rules[0],
      ).toMatchObject({
        conditions: {
          all: [
            {
              fact: "average_score_score2",
              operator: "greaterThanInclusive",
              value: 0.5,
            },
          ],
        },
        event: { type: "continue" },
      });
    },
  );

  test.concurrent(
    "stepSignals property map produces same condition as signal()",
    () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(({ stepSignals }) => ({
          default: "block",
          rules: [stepSignals.success.eq(true).then("continue")],
        }))
        .build();

      expect(
        spec.steps[0]!.advancementPolicyDefinition.rulesJson.rules[0],
      ).toMatchObject({
        conditions: {
          all: [{ fact: "success", operator: "equal", value: true }],
        },
        event: { type: "continue" },
      });
    },
  );

  test.concurrent("multi-step pipeline with .advance() on each step", () => {
    const fromBuilder = pipeline({ key: "p", name: "P" })
      .step(reproduceStep, ({ input }) => ({
        title: input.workItemTitle,
        description: input.workItemDescription,
      }))
      .advance(({ signal }) => ({
        default: "block",
        rules: [signal("success").eq(true).then("continue")],
      }))
      .step(verifyStep, ({ signal, output }) => ({
        reproUrl: signal(reproduceStep, "repro_url"),
        checkSuccess: signal(reproduceStep, "success"),
        fullPrior: output(reproduceStep),
      }))
      .advance(({ signal }) => ({
        default: "complete",
        rules: [signal("passed").eq(true).then("continue")],
      }))
      .build();

    expect(fromBuilder.steps).toHaveLength(2);
    expect(
      fromBuilder.steps[0]!.advancementPolicyDefinition.defaultEventType,
    ).toBe("block");
    expect(
      fromBuilder.steps[1]!.advancementPolicyDefinition.defaultEventType,
    ).toBe("complete");
    expect(
      fromBuilder.steps[0]!.advancementPolicyDefinition.rulesJson.rules[0]!
        .conditions,
    ).toMatchObject({
      all: [{ fact: "success", operator: "equal", value: true }],
    });
    expect(
      fromBuilder.steps[1]!.advancementPolicyDefinition.rulesJson.rules[0]!
        .conditions,
    ).toMatchObject({
      all: [{ fact: "passed", operator: "equal", value: true }],
    });
  });
});

describe("pipeline() builder — parity coverage (Phase 5)", () => {
  describe("step ordering and metadata", () => {
    test.concurrent("assigns positions 1-indexed in declaration order", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .step(verifyStep, ({ signal, output }) => ({
          reproUrl: signal(reproduceStep, "repro_url"),
          checkSuccess: signal(reproduceStep, "success"),
          fullPrior: output(reproduceStep),
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      expect(spec.steps[0]!.position).toBe(1);
      expect(spec.steps[1]!.position).toBe(2);
    });

    test.concurrent(
      "carries step key, name, and description into the output",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.stepKey).toBe("reproduce");
        expect(spec.steps[0]!.stepName).toBe("Reproduce Issue");
        expect(spec.steps[0]!.stepDescription).toBeNull();
      },
    );
  });

  describe("input bindings", () => {
    test.concurrent(
      "workItemTitle and workItemDescription are auto-injected into every step",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(noInputStep, () => ({}))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          workItemTitle: { source: "work_item", field: "title" },
          workItemDescription: { source: "work_item", field: "description" },
        });
      },
    );

    test.concurrent(
      "input.workItemTitle and input.workItemDescription bind to work_item source",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          title: { source: "work_item", field: "title" },
          description: { source: "work_item", field: "description" },
        });
      },
    );

    test.concurrent(
      "pipeline-level inputBindings via workItem.field are injected into every step",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalPipelineInput: {
            schema: z.object({
              company: z.string().nullable(),
              storyPoints: z.number().nullable(),
            }),
            bindings: ({ workItem }) => ({
              company: workItem.field("Company"),
              storyPoints: workItem.field("Story Points"),
            }),
          },
        })
          .step(noInputStep, () => ({}))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          workItemTitle: { source: "work_item", field: "title" },
          workItemDescription: { source: "work_item", field: "description" },
          company: { source: "work_item", field: "fields.Company" },
          storyPoints: { source: "work_item", field: "fields.Story Points" },
        });
      },
    );

    test.concurrent(
      "step-level additionalStepInput bindings are injected into the step",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(enrichedStep, ({ literal }) => ({ priority: literal("high") }))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          jiraProject: { source: "work_item", field: "fields.Jira Project" },
          owner: { source: "literal", value: "platform-team" },
          priority: { source: "literal", value: "high" },
        });
      },
    );

    test.concurrent(
      "pipeline-level additionalStepInput bindings are injected into every step",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalStepInput: {
            schema: z.object({ priority: z.string().nullable() }),
            bindings: ({ workItemField }) => ({
              priority: workItemField("Priority"),
            }),
          },
        })
          .step(enrichedStep, () => ({}))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          priority: { source: "work_item", field: "fields.Priority" },
        });
      },
    );

    test.concurrent(
      "pipeline additionalStepInput overrides step additionalStepInput before explicit bindings",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalStepInput: {
            schema: z.object({ owner: z.string() }),
            bindings: ({ literal }) => ({ owner: literal("pipeline-owner") }),
          },
        })
          .step(enrichedStep, ({ literal }) => ({ owner: literal("explicit-owner") }))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          owner: { source: "literal", value: "explicit-owner" },
        });
      },
    );

    test.concurrent(
      "explicit step bindings override pipeline-level inputBindings",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalPipelineInput: {
            schema: z.object({ title: z.string().optional() }),
            bindings: ({ literal }) => ({ title: literal("from-pipeline") }),
          },
        })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          title: { source: "work_item", field: "title" },
        });
      },
    );

    test.concurrent(
      "literal bindings serialize correctly at pipeline and step level",
      () => {
        const spec = pipeline({
          key: "p",
          name: "P",
          additionalPipelineInput: {
            schema: z.object({ model: z.string() }),
            bindings: ({ literal }) => ({
              model: literal("gpt-4o"),
            }),
          },
        })
          .step(reproduceStep, ({ input, literal }) => ({
            title: input.workItemTitle,
            description: literal("hardcoded description"),
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          model: { source: "literal", value: "gpt-4o" },
          description: { source: "literal", value: "hardcoded description" },
        });
      },
    );

    test.concurrent(
      "additionalPipelineInput.bindings throws on keys not in schema",
      () => {
        expect(() =>
          pipeline({
            key: "p",
            name: "P",
            additionalPipelineInput: {
              schema: z.object({ model: z.string() }),
              bindings: ({ literal }) => ({
                model: literal("gpt-4o"),
                asdf: literal(123),
              }),
            },
          }),
        ).toThrow(
          'additionalPipelineInput.bindings returned key not in schema: "asdf"',
        );
      },
    );

    test.concurrent(
      "additionalStepInput.bindings throws on keys not in schema",
      () => {
        expect(() =>
          pipeline({
            key: "p",
            name: "P",
            additionalStepInput: {
              schema: z.object({ owner: z.string() }),
              bindings: ({ literal }) => ({
                owner: literal("platform"),
                asdf: literal(123),
              }),
            },
          }),
        ).toThrow(
          'additionalStepInput.bindings returned key not in schema: "asdf"',
        );
      },
    );

    test.concurrent(
      "nested input.x.y proxies serialize to dotted-path bindings",
      () => {
        const nestedInputSchema = z.object({
          ticket: z.object({
            title: z.string(),
            description: z.string(),
          }),
        });
        const nestedStep = defineStep({
          key: "nested-step",
          name: "Nested Step",
          agentPrompt: "Do the work.",
          input: z.object({ title: z.string(), description: z.string() }),
          result: z.object({}),
          signals: [],
        });

        const spec = pipeline({
          key: "p",
          name: "P",
          additionalPipelineInput: {
            schema: nestedInputSchema,
            bindings: ({ workItem }) => ({ ticket: workItem.field("ticket") }),
          },
        })
          .step(nestedStep, ({ input }) => ({
            title: input.ticket.title,
            description: input.ticket.description,
          }))
          .advance(() => ({ default: "continue" }))
          .build();

        expect(spec.steps[0]!.inputBindingsJson).toMatchObject({
          title: { source: "pipeline_input", path: "ticket.title" },
          description: { source: "pipeline_input", path: "ticket.description" },
        });
      },
    );
  });

  describe("advancement", () => {
    test.concurrent('defaultOutcome "block" serializes correctly', () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "block" }))
        .build();

      expect(spec.steps[0]!.advancementPolicyDefinition).toMatchObject({
        defaultEventType: "block",
        allowedEventTypes: ["block"],
      });
    });

    test.concurrent("top-level .any() produces an any-mode rule", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(({ signal, any }) => ({
          default: "block",
          rules: [
            any(
              signal("success").eq(true),
              signal("repro_url").contains("localhost"),
            ).then("continue"),
          ],
        }))
        .build();

      const cond = spec.steps[0]!.advancementPolicyDefinition.rulesJson
        .rules[0]!.conditions as {
        any: { fact: string; operator: string; value: unknown }[];
      };
      expect(cond.any).toEqual([
        { fact: "success", operator: "equal", value: true },
        { fact: "repro_url", operator: "contains", value: "localhost" },
      ]);
    });

    test.concurrent("multiple rules per step are preserved in order", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(({ signal }) => ({
          default: "block",
          rules: [
            signal("success").eq(true).then("continue"),
            signal("repro_url").eq("").then("block"),
          ],
        }))
        .build();

      const rules = spec.steps[0]!.advancementPolicyDefinition.rulesJson.rules;
      expect(rules).toHaveLength(2);
      expect(rules[0]!.event.type).toBe("continue");
      expect(rules[1]!.event.type).toBe("block");
    });

    test.concurrent(
      "allowedEventTypes contains the default outcome plus every rule outcome",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance(({ signal, route }) => ({
            default: "block",
            rules: [
              signal("success").eq(true).then("continue"),
              signal("repro_url").eq("").then(route("downstream")),
            ],
          }))
          .build();

        expect(
          spec.steps[0]!.advancementPolicyDefinition.allowedEventTypes,
        ).toEqual(expect.arrayContaining(["block", "continue", "route"]));
      },
    );
  });

  describe("computed signals", () => {
    test.concurrent.each([
      ["avg", "average"],
      ["weightedAvg", "weighted_average"],
      ["sum", "sum"],
      ["min", "min"],
      ["max", "max"],
      ["count", "count"],
    ] as const)(
      "ctx.%s emits a computed signal of type %s",
      (factory, wireType) => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance((ctx) => ({
            default: "block",
            rules: [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (ctx[factory] as any)(
                ctx.stepSignals.score,
                ctx.stepSignals.score2,
              )
                .eq(1)
                .then("continue"),
            ],
          }))
          .build();

        const defs = spec.steps[0]!.computedSignalDefinitions;
        expect(defs).toHaveLength(1);
        expect(defs[0]).toMatchObject({
          type: wireType,
          inputSignalKeys: ["score", "score2"],
        });
      },
    );

    test.concurrent.each([
      ["booleanAny", "boolean_any"],
      ["booleanAll", "boolean_all"],
    ] as const)(
      "ctx.%s emits a computed signal of type %s",
      (factory, wireType) => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance((ctx) => ({
            default: "block",
            rules: [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (ctx[factory] as any)(
                ctx.stepSignals.success,
                ctx.stepSignals.verified,
              )
                .eq(true)
                .then("continue"),
            ],
          }))
          .build();

        const defs = spec.steps[0]!.computedSignalDefinitions;
        expect(defs).toHaveLength(1);
        expect(defs[0]).toMatchObject({
          type: wireType,
          inputSignalKeys: ["success", "verified"],
        });
      },
    );

    test.concurrent("same computed token across rules is deduped", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(({ sum, stepSignals }) => ({
          default: "block",
          rules: [
            sum(stepSignals.score, stepSignals.score2).eq(1).then("continue"),
            sum(stepSignals.score, stepSignals.score2).eq(0).then("block"),
          ],
        }))
        .build();

      expect(spec.steps[0]!.computedSignalDefinitions).toHaveLength(1);
      expect(spec.steps[0]!.computedSignalDefinitions[0]!.key).toBe(
        "sum_score_score2",
      );
    });

    test.concurrent(
      "computed nested inside all/any groups is still extracted",
      () => {
        const spec = pipeline({ key: "p", name: "P" })
          .step(reproduceStep, ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }))
          .advance(({ all, any, max, min, signal, stepSignals }) => ({
            default: "block",
            rules: [
              all(
                max(stepSignals.score, stepSignals.score2).eq(10),
                any(
                  min(stepSignals.score, stepSignals.score2).eq(0),
                  signal("repro_url").contains("https"),
                ),
              ).then("continue"),
            ],
          }))
          .build();

        const keys = spec.steps[0]!.computedSignalDefinitions.map(
          (d) => d.key,
        ).sort();
        expect(keys).toEqual(["max_score_score2", "min_score_score2"]);
      },
    );
  });

  describe("timeout", () => {
    test.concurrent("timeoutSeconds defaults to null when omitted", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(reproduceStep, ({ input }) => ({
          title: input.workItemTitle,
          description: input.workItemDescription,
        }))
        .advance(() => ({ default: "continue" }))
        .build();

      expect(spec.steps[0]!.timeoutSeconds).toBeNull();
    });

    test.concurrent("config callback sets timeoutSeconds on the step", () => {
      const spec = pipeline({ key: "p", name: "P" })
        .step(
          reproduceStep,
          ({ input }) => ({
            title: input.workItemTitle,
            description: input.workItemDescription,
          }),
          (cfg) => {
            cfg.timeout = 900;
          },
        )
        .advance(() => ({ default: "continue" }))
        .build();

      expect(spec.steps[0]!.timeoutSeconds).toBe(900);
    });
  });

  describe("end-to-end", () => {
    test.concurrent(
      "representative non-trivial pipeline produces correct spec",
      () => {
        const spec = pipeline({
          key: "ticket-router",
          name: "Ticket Router",
          description: "scores then routes",
        })
          .step(
            reproduceStep,
            ({ input }) => ({
              title: input.workItemTitle,
              description: input.workItemDescription,
            }),
            (cfg) => {
              cfg.timeout = 300;
            },
          )
          .advance(({ avg, signal, stepSignals }) => ({
            default: "complete",
            rules: [
              avg(stepSignals.score, stepSignals.score2)
                .gte(0.8)
                .then("continue"),
              signal("success").eq(false).then("block"),
            ],
          }))
          .step(verifyStep, ({ signal, output }) => ({
            reproUrl: signal(reproduceStep, "repro_url"),
            checkSuccess: signal(reproduceStep, "success"),
            fullPrior: output(reproduceStep),
          }))
          .advance(({ signal, all, route }) => ({
            default: "complete",
            rules: [
              all(signal("passed").eq(true)).then(
                route("downstream", { ok: true }),
              ),
              signal("passed").eq(false).then("block"),
            ],
          }))
          .build();

        expect(spec.key).toBe("ticket-router");
        expect(spec.description).toBe("scores then routes");
        expect(spec.steps).toHaveLength(2);

        const step0 = spec.steps[0]!;
        expect(step0.stepKey).toBe("reproduce");
        expect(step0.timeoutSeconds).toBe(300);
        expect(step0.inputBindingsJson).toMatchObject({
          title: { source: "work_item", field: "title" },
          description: { source: "work_item", field: "description" },
        });
        expect(step0.advancementPolicyDefinition.defaultEventType).toBe(
          "complete",
        );
        expect(step0.advancementPolicyDefinition.rulesJson.rules).toHaveLength(
          2,
        );
        expect(step0.computedSignalDefinitions).toHaveLength(1);

        const step1 = spec.steps[1]!;
        expect(step1.stepKey).toBe("verify");
        expect(step1.inputBindingsJson).toMatchObject({
          reproUrl: {
            source: "step_signal",
            stepKey: "reproduce",
            signalKey: "repro_url",
          },
          checkSuccess: {
            source: "step_signal",
            stepKey: "reproduce",
            signalKey: "success",
          },
          fullPrior: { source: "step_output", stepKey: "reproduce" },
        });
        expect(step1.advancementPolicyDefinition.rulesJson.rules).toHaveLength(
          2,
        );
      },
    );
  });
});
