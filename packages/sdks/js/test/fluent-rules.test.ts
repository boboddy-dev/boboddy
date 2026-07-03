import { describe, expect, test } from "bun:test";
import { makeAdvanceCtx } from "../src/definitions/advancement-policies/fluent-rules";

type Keys = "score" | "passed" | "tier";

describe("fluent rules", () => {
  test.concurrent("signal(key).gte(n).then(outcome) produces a leaf rule", () => {
    const ctx = makeAdvanceCtx<Keys>();
    const rule = ctx.signal("score").gte(0.8).then("continue");

    expect(rule).toEqual({
      _tag: "rule",
      mode: "all",
      conditions: [
        {
          _tag: "signal",
          signal: "score",
          operator: "greaterThanInclusive",
          value: 0.8,
        },
      ],
      outcome: "continue",
    });
  });

  test.concurrent("all(...).then(outcome) produces an all-mode rule", () => {
    const ctx = makeAdvanceCtx<Keys>();
    const rule = ctx
      .all(ctx.signal("score").gte(0.8), ctx.signal("passed").eq(true))
      .then("continue");

    expect(rule.mode).toBe("all");
    expect(rule.conditions).toHaveLength(2);
    expect(rule.conditions[0]).toMatchObject({
      _tag: "signal",
      signal: "score",
      operator: "greaterThanInclusive",
    });
    expect(rule.conditions[1]).toMatchObject({
      _tag: "signal",
      signal: "passed",
      operator: "equal",
      value: true,
    });
  });

  test.concurrent("any(...).then(outcome) produces an any-mode rule", () => {
    const ctx = makeAdvanceCtx<Keys>();
    const rule = ctx
      .any(ctx.signal("passed").eq(true), ctx.signal("tier").eq("vip"))
      .then("continue");

    expect(rule.mode).toBe("any");
    expect(rule.conditions).toHaveLength(2);
  });

  test.concurrent("groups can nest", () => {
    const ctx = makeAdvanceCtx<Keys>();
    const rule = ctx
      .all(
        ctx.signal("score").gte(0.8),
        ctx.any(ctx.signal("passed").eq(true), ctx.signal("tier").eq("vip")),
      )
      .then("continue");

    expect(rule.conditions[1]).toMatchObject({
      _tag: "any",
      conditions: [
        { _tag: "signal", signal: "passed" },
        { _tag: "signal", signal: "tier" },
      ],
    });
  });

  test.concurrent("computed factories produce inline computed signals", () => {
    const ctx = makeAdvanceCtx<Keys>();
    const rule = ctx.avg(ctx.stepSignals.score, ctx.stepSignals.passed).gte(0.5).then("continue");

    const cond = rule.conditions[0];
    expect(cond).toBeDefined();
    if (cond?._tag !== "signal") throw new Error("expected signal condition");
    if (typeof cond.signal === "string") {
      throw new Error("expected inline computed signal token");
    }
    expect(cond.signal).toMatchObject({
      _tag: "computed_signal",
      type: "average",
      inputSignalKeys: ["score", "passed"],
      key: "average_score_passed",
    });
  });

  test.concurrent("route() produces a RouteOutcome", () => {
    const ctx = makeAdvanceCtx<Keys>();
    expect(ctx.route("other-pipeline")).toEqual({
      outcome: "route",
      pipelineKey: "other-pipeline",
    });
    expect(ctx.route("p", { foo: 1 })).toEqual({
      outcome: "route",
      pipelineKey: "p",
      inputJson: { foo: 1 },
    });
  });

  test.concurrent("operator mapping covers all comparators", () => {
    const ctx = makeAdvanceCtx<Keys>();
    const sig = ctx.signal("score");
    const ops: Array<[string, (s: typeof sig) => unknown, string]> = [
      ["eq", (s) => s.eq(1), "equal"],
      ["ne", (s) => s.ne(1), "notEqual"],
      ["gt", (s) => s.gt(1), "greaterThan"],
      ["gte", (s) => s.gte(1), "greaterThanInclusive"],
      ["lt", (s) => s.lt(1), "lessThan"],
      ["lte", (s) => s.lte(1), "lessThanInclusive"],
      ["in", (s) => s.in([1, 2]), "in"],
      ["notIn", (s) => s.notIn([1, 2]), "notIn"],
      ["contains", (s) => s.contains("x"), "contains"],
      ["doesNotContain", (s) => s.doesNotContain("x"), "doesNotContain"],
    ];
    for (const [, build, expected] of ops) {
      const leaf = build(sig) as { then: (o: string) => { conditions: Array<{ operator: string }> } };
      const rule = leaf.then("continue");
      const cond0 = rule.conditions[0];
      if (!cond0) throw new Error("expected condition");
      expect(cond0.operator).toBe(expected);
    }
  });
});
