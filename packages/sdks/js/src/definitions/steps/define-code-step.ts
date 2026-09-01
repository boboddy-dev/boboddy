import { toJSONSchema } from "zod/v4/core";
import type { $ZodType } from "zod/v4/core";
import type { ZodType } from "zod";
import type {
  SignalKeysOf,
  SignalTypeMapOf,
  StepDefinitionSpec,
  TypedStepDefinitionSpec,
} from "./define-step";

/**
 * `codeStep()`'s own signal spec shape — unlike `defineStep()`'s
 * `SignalSpecInput`, `type` is required rather than inferred from the
 * result schema at a dot-path (`resolveZodSchemaAtPath`/
 * `zodTypeToSignalType` are `define-step.ts`-internal, and a code step's
 * result shape is arbitrary application data, not necessarily reflecting
 * one at all) — a small, deliberate simplification over `defineStep`'s own
 * signal authoring surface.
 */
export type CodeStepSignalSpec = {
  key?: string;
  sourcePath: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  availableWhenResultStatusIn?: string[] | null;
};

export type CodeStepFn<TInput, TResult> = (
  input: TInput,
) => TResult | Promise<TResult>;

export type DefineCodeStepInput<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
> = {
  key: string;
  name: string;
  description?: string | null;
  version?: number;
  /**
   * The step's own implementation — resolved by `collect-definitions.ts`
   * to a portable `{sourceFile, exportName}` pair (by identity-matching
   * this reference against the declaring module's other exports) before
   * the (unserializable) function reference is ever sent over the wire.
   * Must be a plain named export of the same module `codeStep()` is
   * called from (see docs/research/flat-pipeline-sdk-and-visual-designer.md
   * §7.7/§8's "code-step entrypoints resolve against the target repo").
   */
  fn: CodeStepFn<TInput["_output"], TResult["_output"]>;
  inputSchema?: TInput;
  resultSchema?: TResult;
  signals?: readonly CodeStepSignalSpec[];
  status?: "draft" | "active";
};

/**
 * Defines a `kind: "code"` step: a plain function instead of an LLM
 * prompt. Produces the same phantom-typed `TypedStepDefinitionSpec` shape
 * `defineStep()` does (so it plugs into `definePipeline()`'s
 * `states[key].step` field unchanged), but with no `prompt` and a live
 * `entrypoint.fn` reference attached instead — see `StepDefinitionSpec`'s
 * own doc comment for what happens to it during collection.
 */
export function codeStep<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  const TSignals extends ReadonlyArray<CodeStepSignalSpec> = never[],
>(
  config: DefineCodeStepInput<TInput, TResult> & { signals?: TSignals },
): TypedStepDefinitionSpec<
  TInput["_output"],
  TResult["_output"],
  SignalKeysOf<TSignals>,
  SignalTypeMapOf<TSignals, TResult["_output"]>
> {
  const spec: StepDefinitionSpec = {
    key: config.key,
    name: config.name,
    description: config.description ?? null,
    version: config.version ?? 1,
    kind: "code",
    status: config.status ?? "active",
    prompt: null,
    inputSchemaJson: config.inputSchema
      ? toJSONSchema(config.inputSchema as unknown as $ZodType)
      : null,
    resultSchemaJson: config.resultSchema
      ? toJSONSchema(config.resultSchema as unknown as $ZodType)
      : null,
    signalExtractorDefinitions: (config.signals ?? []).map((signal) => ({
      key: signal.key ?? signal.sourcePath,
      sourcePath: signal.sourcePath,
      type: signal.type,
      required: signal.required ?? true,
      availableWhenResultStatusIn: signal.availableWhenResultStatusIn ?? null,
    })),
    opencodeMcpJson: null,
    opencodePluginJson: null,
    healthChecksJson: null,
    entrypoint: { fn: config.fn },
  };

  return spec as TypedStepDefinitionSpec<
    TInput["_output"],
    TResult["_output"],
    SignalKeysOf<TSignals>,
    SignalTypeMapOf<TSignals, TResult["_output"]>
  >;
}
