// Phase 2 checks: does every binding-carrying node's `inputBindingsJson`
// actually satisfy the step it feeds?
//
// Three checks, all keyed off the same "every binding-carrying location in a
// pipeline" walk (`bindingContexts` below — a working node's own bindings,
// plus each `parallel` branch's own, independent bindings):
//
//   1. `unbound-required-input` — a required `additionalInput` field the
//      consumer step declares has no binding at all (error: the step will
//      fail Zod validation at execution time).
//   2. `binding-target-field` — two sub-checks of differing severity:
//      (a) info: a bound field name that doesn't exist on the consumer
//      step's `additionalInput`. This is *allowed* — extra context bound
//      onto a step that doesn't declare it as an `additionalInput` field is
//      silently dropped, not an error at execution time — but it's still
//      surfaced at info level in case it's an unintentional typo rather
//      than deliberate extra context. (b) error: a `work_item` binding
//      whose `field` names neither a known top-level work-item field nor a
//      `fields.`-prefixed platform field (silently `undefined` at resolve
//      time, and never an intentional pattern the way (a) can be).
//   3. `binding-type-mismatch` (warning, not error) — both the binding's
//      source and its target field resolve to a known `SchemaType` (per
//      `json-schema-paths.ts`'s Phase 1 helpers) and they disagree. Skipped
//      whenever either side is `"unknown"` — the same "never a false
//      positive" bias `json-schema-paths.ts` documents for path resolution.
//
// Split out of `validate-definition-specs.ts` (rather than added to it
// directly) to keep both files under the repo's `max-lines` limit; see
// `validation-issue.ts` for why the shared type had to move too.

import {
  isWorkingNodeDefinition,
  type NodeDefinitionSpec,
  type PipelineDefinitionSpec,
} from "../pipelines/define-pipeline";
import type { SerializedBinding } from "../pipelines/bindings";
import {
  WORK_ITEM_FIELDS_PATH_PREFIX,
  WORK_ITEM_TOP_LEVEL_FIELDS,
} from "../pipelines/work-item-fields";
import type { StepDefinitionSpec } from "../steps/define-step";
import {
  resolvePathType,
  resolveSchemaType,
  type JsonSchemaNode,
  type SchemaType,
} from "./json-schema-paths";
import { listPaths, type DefinitionValidationIssue } from "./validation-issue";

const WORK_ITEM_TOP_LEVEL_FIELD_SET: ReadonlySet<string> = new Set(
  WORK_ITEM_TOP_LEVEL_FIELDS,
);

/** `workItemTitle`/`workItemDescription` — see `bindings.ts`'s `serializeInputBindings`. */
function isAutoBoundWorkItemField(field: string): boolean {
  return field === "workItemTitle" || field === "workItemDescription";
}

// ─── Every binding-carrying location in a pipeline ────────────────────────────

type BindingContext = {
  readonly nodeKey: string;
  /** Set only for a `parallel` node's own branch — `null` otherwise. */
  readonly branchKey: string | null;
  /** The step this location's bindings feed, independent of any other node's. */
  readonly stepKey: string;
  readonly inputBindingsJson: Record<string, SerializedBinding>;
};

/**
 * Every location in a pipeline that carries its own `inputBindingsJson` and
 * its own `stepKey` to check them against: a `step`/`fanOut`/`loop` node's
 * own bindings, or a `parallel` node's own branches (each of which binds its
 * *own* `stepKey`'s step independently — see `ParallelBranchSpec`). No other
 * node kind (`cohortGate`/`choice`/`succeed`/`fail`) carries bindings at all.
 */
function bindingContexts(pipeline: PipelineDefinitionSpec): BindingContext[] {
  const contexts: BindingContext[] = [];

  for (const node of pipeline.nodeDefinitions) {
    if (isWorkingNodeDefinition(node)) {
      contexts.push({
        nodeKey: node.nodeKey,
        branchKey: null,
        stepKey: node.stepKey,
        // A hand-edited/generated working-kind node may not actually set
        // `inputBindingsJson` at runtime — see `validate-definition-specs.ts`'s
        // file header for why this stays a runtime-defensive check.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hand-edited/generated working-kind node may not actually set `inputBindingsJson` at runtime
        inputBindingsJson: node.inputBindingsJson ?? {},
      });
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hand-edited/generated spec may claim `kind: "parallel"` without setting `branches`
    if (node.kind === "parallel" && node.branches) {
      for (const [branchKey, branch] of Object.entries(node.branches)) {
        contexts.push({
          nodeKey: node.nodeKey,
          branchKey,
          stepKey: branch.stepKey,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- hand-edited/generated branch may not actually set `inputBindingsJson` at runtime
          inputBindingsJson: branch.inputBindingsJson ?? {},
        });
      }
    }
  }

  return contexts;
}

function bindingContextLabel(
  pipelineKey: string,
  ctx: BindingContext,
): string {
  return ctx.branchKey
    ? `Pipeline "${pipelineKey}" node "${ctx.nodeKey}" branch "${ctx.branchKey}"`
    : `Pipeline "${pipelineKey}" node "${ctx.nodeKey}"`;
}

// ─── Reading a consumer step's `additionalInput` schema ───────────────────────
//
// Multiple versions of the same step key can be present in one batch
// (`stepsByKey`'s value is an array). These helpers union facts across every
// version present, the same permissive convention
// `validate-definition-specs.ts`'s `declaredSignalKeys` uses for signal keys:
// a field counts as "known"/"required" if *any* version says so, which never
// produces a false "unbound"/"unknown field" report just because a binding
// happens to target an older or newer version's shape.

function knownInputFields(
  specs: readonly StepDefinitionSpec[],
): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const spec of specs) {
    const schema = spec.inputSchemaJson;
    if (!schema) continue;
    const properties = schema["properties"];
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      continue;
    }
    for (const key of Object.keys(properties)) fields.add(key);
  }
  return fields;
}

function requiredInputFields(
  specs: readonly StepDefinitionSpec[],
): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const spec of specs) {
    const schema = spec.inputSchemaJson;
    if (!schema) continue;
    const required = schema["required"];
    if (!Array.isArray(required)) continue;
    for (const entry of required) {
      if (typeof entry === "string") fields.add(entry);
    }
  }
  return fields;
}

// This is the narrowing boundary for raw JSON read off `properties[field]` —
// see `json-schema-paths.ts`'s own `isSchemaNode`, which this mirrors.
// eslint-disable-next-line local/no-unknown-parameter-type
function isJsonSchemaNode(value: unknown): value is JsonSchemaNode {
  return (
    typeof value === "boolean" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  );
}

/**
 * The first version (in `specs` order) that declares `field` on its
 * `additionalInput` schema, paired with that *same* version's whole
 * `inputSchemaJson` as the `$ref` document root — mixing one version's
 * property node with another's root would resolve `$ref`s against the wrong
 * `$defs`. `null` when no version declares the field at all.
 */
function findPropertyNode(
  specs: readonly StepDefinitionSpec[],
  field: string,
): { readonly node: JsonSchemaNode; readonly root: JsonSchemaNode } | null {
  for (const spec of specs) {
    const schema = spec.inputSchemaJson;
    if (!schema) continue;
    const properties = schema["properties"];
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      continue;
    }
    const node: unknown = (properties as Record<string, unknown>)[field];
    if (isJsonSchemaNode(node)) return { node, root: schema };
  }
  return null;
}

// ─── Check 5: every required additionalInput field is bound ──────────────────

function checkUnboundRequiredInputs(
  pipelines: readonly PipelineDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const pipeline of pipelines) {
    for (const ctx of bindingContexts(pipeline)) {
      const specs = stepsByKey.get(ctx.stepKey);
      // Not in this batch — the server may already know the underlying
      // step. Nothing provable, same bias as `declaredSignalKeys`.
      if (!specs) continue;

      const required = requiredInputFields(specs);
      if (required.size === 0) continue;

      const bound = new Set(Object.keys(ctx.inputBindingsJson));
      const missing = [...required]
        .filter((field) => !bound.has(field) && !isAutoBoundWorkItemField(field))
        .sort();
      if (missing.length === 0) continue;

      const where = bindingContextLabel(pipeline.key, ctx);
      const boundList = [
        ...bound,
        "workItemTitle",
        "workItemDescription",
      ].sort();

      for (const field of missing) {
        issues.push({
          check: "unbound-required-input",
          severity: "error",
          pipelineKey: pipeline.key,
          nodeKey: ctx.nodeKey,
          branchKey: ctx.branchKey ?? undefined,
          message:
            `${where} runs step "${ctx.stepKey}", which requires input "${field}", ` +
            `but no binding provides it. Bound inputs: ${listPaths(boundList)}.`,
        });
      }
    }
  }

  return issues;
}

// ─── Check 6: bound field names actually exist ────────────────────────────────
//
// Two distinct "does this name exist" questions: (a) the step-input field
// name (`inputBindingsJson`'s own key) isn't one the consumer step's
// `additionalInput` declares — allowed (the value is just dropped), so only
// info-tier, since a step may legitimately be handed context it doesn't
// declare as an input; and (b) a `work_item`-sourced binding's own `field`
// (the work-item property being read, e.g. `"title"`/`"fields.customLabel"`)
// names neither a known top-level work-item field nor a `fields.`-prefixed
// platform field — always a broken reference, so this one stays error-tier.

function checkBindingTargetFields(
  pipelines: readonly PipelineDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const pipeline of pipelines) {
    for (const ctx of bindingContexts(pipeline)) {
      const specs = stepsByKey.get(ctx.stepKey);
      const knownFields = specs ? knownInputFields(specs) : null;
      const where = bindingContextLabel(pipeline.key, ctx);

      for (const [field, binding] of Object.entries(ctx.inputBindingsJson)) {
        if (
          knownFields &&
          !isAutoBoundWorkItemField(field) &&
          !knownFields.has(field)
        ) {
          issues.push({
            check: "binding-target-field",
            // Allowed, not an execution-time error — the value is just
            // dropped — so this is surfaced at info level only, in case it's
            // an unintentional typo rather than deliberate extra context.
            severity: "info",
            pipelineKey: pipeline.key,
            nodeKey: ctx.nodeKey,
            branchKey: ctx.branchKey ?? undefined,
            message:
              `${where} is passing information ("${field}") to step "${ctx.stepKey}" ` +
              `that it isn't explicitly asking for — the step declares no such ` +
              `additionalInput field, so the value is dropped. Declared fields: ` +
              `${knownFields.size > 0 ? listPaths([...knownFields].sort()) : "(none)"}.`,
          });
        }

        if (
          binding.source === "work_item" &&
          !binding.field.startsWith(WORK_ITEM_FIELDS_PATH_PREFIX) &&
          !WORK_ITEM_TOP_LEVEL_FIELD_SET.has(binding.field)
        ) {
          issues.push({
            check: "binding-target-field",
            severity: "error",
            pipelineKey: pipeline.key,
            nodeKey: ctx.nodeKey,
            branchKey: ctx.branchKey ?? undefined,
            message:
              `${where} binds input "${field}" to work_item field "${binding.field}", ` +
              `which is not a known top-level work-item field and does not start ` +
              `with "${WORK_ITEM_FIELDS_PATH_PREFIX}". Known top-level fields: ` +
              `${listPaths(WORK_ITEM_TOP_LEVEL_FIELDS)}.`,
          });
        }
      }
    }
  }

  return issues;
}

// ─── Check 7: a resolved source type agrees with a resolved target type ──────

function describeBindingSource(binding: SerializedBinding): string {
  switch (binding.source) {
    case "step_signal":
      return `signal "${binding.signalKey}" of node "${binding.stepKey}"`;
    case "step_output":
      return `the output of node "${binding.stepKey}"`;
    case "signals_list":
      return `the signals list of fan-out node "${binding.stepKey}"`;
    case "pipeline_input":
      return `pipeline input "${binding.path}"`;
    case "work_item":
      return `work_item field "${binding.field}"`;
    case "literal":
      return "a literal value";
    case "fan_out_item":
      return "the fan-out item";
  }
}

/**
 * The `SchemaType` a binding's *source* resolves to, per §4's table.
 * `"unknown"` (never a guess) whenever the source isn't statically
 * resolvable — including `fan_out_item`, which this file's header documents
 * as an intentional v1 gap (its type depends on the fan-out's
 * `overSignalKey`'s *element* type, not modeled anywhere in these specs),
 * and `literal`, which has no declared type to compare (the value is
 * whatever JSON the author wrote).
 */
function bindingSourceType(
  binding: SerializedBinding,
  pipeline: PipelineDefinitionSpec,
  nodeByKey: ReadonlyMap<string, NodeDefinitionSpec>,
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): SchemaType {
  if (binding.source === "step_signal") {
    const producerNode = nodeByKey.get(binding.stepKey);
    if (!producerNode || !isWorkingNodeDefinition(producerNode)) return "unknown";
    const specs = stepsByKey.get(producerNode.stepKey) ?? [];
    for (const spec of specs) {
      const signal = spec.signalExtractorDefinitions.find(
        (candidate) => candidate.key === binding.signalKey,
      );
      if (signal) return signal.type;
    }
    return "unknown";
  }

  if (binding.source === "step_output") {
    const producerNode = nodeByKey.get(binding.stepKey);
    if (!producerNode || !isWorkingNodeDefinition(producerNode)) return "unknown";
    const specs = stepsByKey.get(producerNode.stepKey) ?? [];
    for (const spec of specs) {
      if (spec.resultSchemaJson) return resolveSchemaType(spec.resultSchemaJson);
    }
    return "unknown";
  }

  if (binding.source === "signals_list") return "array";

  if (binding.source === "pipeline_input") {
    return pipeline.inputSchemaJson
      ? resolvePathType(pipeline.inputSchemaJson, binding.path)
      : "unknown";
  }

  if (binding.source === "work_item") {
    // `fields.<name>` reaches a platform-specific bag with no statically
    // known type — never a false positive.
    if (binding.field.startsWith(WORK_ITEM_FIELDS_PATH_PREFIX)) return "unknown";
    // Every known top-level work-item field is fundamentally string-typed
    // (`WorkItemTopLevelFieldTypeMap` — the nullable/platform-literal
    // variants collapse to `"string"` here; a deliberate simplification, not
    // a bug — see this function's own doc comment). A field name that is
    // neither a known top-level field nor `fields.`-prefixed is a broken
    // reference, already flagged by `checkBindingTargetFields` — not a
    // type-mismatch, so this resolves to `"unknown"` and the caller skips it.
    return WORK_ITEM_TOP_LEVEL_FIELD_SET.has(binding.field) ? "string" : "unknown";
  }

  // `literal` and `fan_out_item` — see this function's own doc comment.
  return "unknown";
}

function checkBindingTypeCompatibility(
  pipelines: readonly PipelineDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const pipeline of pipelines) {
    const nodeByKey = new Map(
      pipeline.nodeDefinitions.map((node) => [node.nodeKey, node]),
    );

    for (const ctx of bindingContexts(pipeline)) {
      const specs = stepsByKey.get(ctx.stepKey);
      const where = bindingContextLabel(pipeline.key, ctx);

      for (const [field, binding] of Object.entries(ctx.inputBindingsJson)) {
        // `fan_out_item` is never type-checked (see `bindingSourceType`'s
        // doc comment) and `workItemTitle`/`workItemDescription` have no
        // target-type resolution in this phase — they aren't part of the
        // consumer step's own `additionalInput` schema, so there is nothing
        // in `specs` to resolve a target type against; skip rather than
        // guess.
        if (binding.source === "fan_out_item") continue;
        if (isAutoBoundWorkItemField(field)) continue;
        if (!specs) continue;

        const target = findPropertyNode(specs, field);
        if (!target) continue;
        const targetType = resolveSchemaType(target.node, target.root);
        if (targetType === "unknown") continue;

        const sourceType = bindingSourceType(binding, pipeline, nodeByKey, stepsByKey);
        if (sourceType === "unknown") continue;
        if (sourceType === targetType) continue;

        issues.push({
          check: "binding-type-mismatch",
          severity: "warning",
          pipelineKey: pipeline.key,
          nodeKey: ctx.nodeKey,
          branchKey: ctx.branchKey ?? undefined,
          message:
            `${where} binds input "${field}" (declared type "${targetType}") to ` +
            `${describeBindingSource(binding)}, which resolves to type ` +
            `"${sourceType}" — the types disagree.`,
        });
      }
    }
  }

  return issues;
}

export {
  checkBindingTargetFields,
  checkBindingTypeCompatibility,
  checkUnboundRequiredInputs,
};
