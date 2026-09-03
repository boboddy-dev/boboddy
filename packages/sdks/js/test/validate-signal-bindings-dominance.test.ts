// `checkSignalBindings` (`validate-definition-specs.ts`, Check 4) used to
// accept any binding whose producer had a strictly lower topo-rank than its
// consumer — a linearization, not a path guarantee. Now that convergent
// edges are unconditionally legal (not just from `choice`/`loop` sources —
// see `definePipeline — convergent edges` in `define-pipeline-fan-out-
// parallel-loop.test.ts`), a producer that only runs down one branch of a
// `choice` can still rank below a consumer it converges into from another
// branch, which this file's fixtures reproduce directly (bypassing
// `pipelineSpec()`'s sequential-edge synthesis, since these shapes are
// exactly the branching graphs it can't express — see its own doc comment).
//
// No step specs are passed to `validateDefinitionSpecs` here on purpose:
// with `stepsByKey` empty, `declaredSignalKeys` returns `null` ("nothing
// provable" — see its own doc comment), so the signal-key-existence
// sub-check never fires and every issue below is `checkSignalBindings`'s
// dominance check alone.

import { describe, expect, test } from "bun:test";
import type {
  DependencyEdgeSpec,
  NodeDefinitionSpec,
  PipelineDefinitionSpec,
} from "../src/definitions/pipelines";
import type { SerializedBinding } from "../src/definitions/pipelines/bindings";
import { validateDefinitionSpecs } from "../src/definitions/validation";

const ADVANCEMENT_POLICY = {
  rulesJson: { rules: [] },
  defaultEventType: "continue" as const,
  defaultEventParamsJson: null,
  allowedEventTypes: ["continue" as const],
};

function stepNode(
  nodeKey: string,
  inputBindingsJson: Record<string, SerializedBinding> = {},
): NodeDefinitionSpec {
  return {
    nodeKey,
    kind: "step",
    stepKey: nodeKey,
    stepName: nodeKey,
    stepDescription: null,
    inputBindingsJson,
    timeoutSeconds: null,
    advancementPolicyDefinition: ADVANCEMENT_POLICY,
    computedSignalDefinitions: [],
  };
}

function choiceNode(nodeKey: string): NodeDefinitionSpec {
  return { nodeKey, kind: "choice", choices: [], default: null };
}

function edge(fromNodeKey: string, toNodeKey: string): DependencyEdgeSpec {
  return { fromNodeKey, toNodeKey };
}

/**
 * `start -> choice -+-> pageOncall -+-> summarize`
 *                    +-------------------^
 *
 * The shape from the plan this test exists to cover: `pageOncall` runs on
 * only one of `choice`'s branches, so it must not be treated as a legal
 * binding source for `summarize`, even though it has a lower topo-rank.
 * `start` runs on every path (it's the entry, before the branch even
 * exists), so it remains a legal source.
 */
function convergentPipeline(
  summarizeBindings: Record<string, SerializedBinding>,
): PipelineDefinitionSpec {
  return {
    key: "p",
    name: "p",
    description: null,
    version: 1,
    status: "active",
    entryNodeKey: "start",
    nodeDefinitions: [
      stepNode("start"),
      choiceNode("choice"),
      stepNode("pageOncall"),
      stepNode("summarize", summarizeBindings),
    ],
    dependencyEdges: [
      edge("start", "choice"),
      edge("choice", "pageOncall"),
      edge("choice", "summarize"),
      edge("pageOncall", "summarize"),
    ],
  };
}

describe("validateDefinitionSpecs — signal bindings across convergent branches", () => {
  test("rejects a binding to a node that only runs down one branch", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        convergentPipeline({
          onCall: { source: "step_signal", stepKey: "pageOncall", signalKey: "ack" },
        }),
      ],
      steps: [],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("signal-binding");
    expect(issues[0]?.message).toContain(
      'Pipeline "p" node "summarize" binds input "onCall" to signal "ack" of node "pageOncall"',
    );
    expect(issues[0]?.message).toContain("does not run on every path");
  });

  test("accepts a binding to a true dominator (a node before the branch)", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        convergentPipeline({
          onCall: { source: "step_signal", stepKey: "start", signalKey: "out" },
        }),
      ],
      steps: [],
    });

    expect(issues).toEqual([]);
  });

  test("still rejects a binding referencing the consumer's own node", () => {
    const issues = validateDefinitionSpecs({
      pipelines: [
        convergentPipeline({
          onCall: { source: "step_signal", stepKey: "summarize", signalKey: "done" },
        }),
      ],
      steps: [],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("does not run on every path");
  });
});
