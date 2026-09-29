// `checkSplitBranchesDontReconverge` (`validate-definition-specs.ts`, Check
// 5) rejects any `split` whose sibling branches ever reach the same
// downstream node — directly or several hops apart. There's no join to
// safely absorb an accidental reconvergence (`split` has none in v1 — see
// `docs/plans/pipeline-split-branching.md` decision 3), so this is caught
// at push time instead of raw-throwing a Postgres unique-constraint
// violation mid-execution the first time it actually happens.
//
// Built with real `definePipeline()` calls (not hand-rolled specs, unlike
// `validate-signal-bindings-dominance.test.ts`) — `split` is a fully
// implemented authoring kind, so exercising the real compiler end-to-end
// is both simpler and closer to what an author would actually write.

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineStep } from "../src/definitions/steps/define-step";
import { definePipeline } from "../src/definitions/pipelines/define-pipeline";
import { validateDefinitionSpecs } from "../src/definitions/validation";

const doStep = defineStep({
  key: "do-step",
  name: "Do",
  agentPrompt: "Do the thing.",
  result: z.object({ ok: z.boolean() }),
  signals: [{ sourcePath: "ok", key: "ok" }],
});

describe("validateDefinitionSpecs — split branches don't reconverge", () => {
  test("accepts a split whose branches never share a downstream node", () => {
    const spec = definePipeline({
      key: "split-disjoint",
      startAt: "fork",
      states: {
        fork: { kind: "split", branches: ["notify", "record"] },
        notify: { kind: "step", step: doStep, next: "notifyDone" },
        record: { kind: "step", step: doStep, next: "recordDone" },
        notifyDone: { kind: "succeed" },
        recordDone: { kind: "succeed" },
      },
    });

    expect(validateDefinitionSpecs({ pipelines: [spec], steps: [] })).toEqual(
      [],
    );
  });

  test("rejects two branches that directly target the same node", () => {
    const spec = definePipeline({
      key: "split-direct-reconverge",
      startAt: "fork",
      states: {
        fork: { kind: "split", branches: ["notify", "record"] },
        notify: { kind: "step", step: doStep, next: "shared" },
        record: { kind: "step", step: doStep, next: "shared" },
        shared: { kind: "succeed" },
      },
    });

    const issues = validateDefinitionSpecs({ pipelines: [spec], steps: [] });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("split-branches-reconverge");
    expect(issues[0]?.pipelineKey).toBe("split-direct-reconverge");
    expect(issues[0]?.nodeKey).toBe("fork");
    expect(issues[0]?.targetNodeKey).toBe("shared");
    expect(issues[0]?.message).toContain('split "fork"');
    expect(issues[0]?.message).toContain('"notify"');
    expect(issues[0]?.message).toContain('"record"');
    expect(issues[0]?.message).toContain('node "shared"');
  });

  test("rejects branches that merge several states downstream", () => {
    const spec = definePipeline({
      key: "split-deep-reconverge",
      startAt: "fork",
      states: {
        fork: { kind: "split", branches: ["notifyStart", "recordStart"] },
        notifyStart: { kind: "step", step: doStep, next: "notifyMiddle" },
        notifyMiddle: { kind: "step", step: doStep, next: "shared" },
        recordStart: { kind: "step", step: doStep, next: "recordMiddle" },
        recordMiddle: { kind: "step", step: doStep, next: "recordLast" },
        recordLast: { kind: "step", step: doStep, next: "shared" },
        shared: { kind: "succeed" },
      },
    });

    const issues = validateDefinitionSpecs({ pipelines: [spec], steps: [] });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("split-branches-reconverge");
    expect(issues[0]?.message).toContain('"notifyStart"');
    expect(issues[0]?.message).toContain('"recordStart"');
    expect(issues[0]?.message).toContain('node "shared"');
  });

  test("a nested split inside one branch composes without false positives against its sibling", () => {
    const spec = definePipeline({
      key: "split-nested",
      startAt: "fork",
      states: {
        fork: { kind: "split", branches: ["branchA", "notify"] },
        branchA: { kind: "step", step: doStep, next: "innerFork" },
        innerFork: { kind: "split", branches: ["x", "y"] },
        x: { kind: "step", step: doStep, next: "xDone" },
        y: { kind: "step", step: doStep, next: "yDone" },
        xDone: { kind: "succeed" },
        yDone: { kind: "succeed" },
        notify: { kind: "step", step: doStep, next: "notifyDone" },
        notifyDone: { kind: "succeed" },
      },
    });

    expect(validateDefinitionSpecs({ pipelines: [spec], steps: [] })).toEqual(
      [],
    );
  });
});
