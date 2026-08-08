import { toJSONSchema } from "zod/v4/core";
import type { $ZodType } from "zod/v4/core";
import type { ZodObject, ZodRawShape, ZodType } from "zod";
import type {
  AnyStepFeature,
  FeatureResultExtensions,
  FeatureSignalKeys,
} from "./step-features";
import {
  createPromptTemplateContext,
  type PromptTemplateContext,
} from "./prompt-template";

/**
 * Resolves the Zod schema node at a dot-notation path within a ZodObject schema.
 * Returns undefined if the path does not exist.
 */
function resolveZodSchemaAtPath(
  schema: ZodType | undefined,
  path: string,
): ZodType | undefined {
  if (!schema) return undefined;
  const segments = path.split(".");
  let current: ZodType | undefined = schema;
  for (const segment of segments) {
    if (!current) return undefined;
    // Unwrap wrapper types (optional, nullable, default, catch, etc.)
    current = unwrapZodWrappers(current);
    const def = (current as unknown as { def?: { type?: string; shape?: Record<string, ZodType> } }).def;
    if (!def || def.type !== "object" || !def.shape) return undefined;
    current = def.shape[segment];
  }
  return current;
}

/**
 * Unwraps Zod wrapper types (optional, nullable, default, catch) to reach the
 * inner type, then maps the resulting Zod type name to a SignalTypeStr.
 */
function zodTypeToSignalType(schema: ZodType | undefined): SignalTypeStr | undefined {
  if (!schema) return undefined;
  const unwrapped = unwrapZodWrappers(schema);
  const def = (unwrapped as unknown as { def?: { type?: string } }).def;
  const typeName = def?.type;
  switch (typeName) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": return "array";
    case "object": return "object";
    default: return undefined;
  }
}

/** Recursively unwraps optional / nullable / default / catch wrappers. */
function unwrapZodWrappers(schema: ZodType): ZodType {
  const def = (schema as unknown as { def?: { type?: string; innerType?: ZodType } }).def;
  if (!def) return schema;
  if (
    def.type === "optional" ||
    def.type === "nullable" ||
    def.type === "default" ||
    def.type === "catch"
  ) {
    if (def.innerType) return unwrapZodWrappers(def.innerType);
  }
  return schema;
}

type OpenCodeMcpServers = Record<
  string,
  | {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    }
  | {
      type: "remote";
      url: string;
      enabled?: boolean;
      headers?: Record<string, string>;
      oauth?:
        | {
            clientId?: string;
            clientSecret?: string;
            scope?: string;
            redirectUri?: string;
          }
        | boolean;
      timeout?: number;
    }
  | {
      enabled: boolean;
    }
>;

/**
 * A single entry in the OpenCode `plugin` config array.
 * Either a package name string or a [packageName, options] tuple.
 */
type OpenCodePluginEntry = string | [string, Record<string, unknown>];

/** Full value of the OpenCode `plugin` config field. */
type OpenCodePlugins = OpenCodePluginEntry[];

type HealthCheckSeverity = "required" | "warn";

/**
 * A single step-declared health check: a real tool call made against the
 * launched environment before the agent starts working.
 *
 * `tool` is a bare name when `mcp` is set (resolved at runtime to
 * `${mcp}_${tool}`); otherwise it is a flat tool id. `mcp`, when present,
 * must name a server declared in this step's `mcpServers`.
 */
type HealthCheck = {
  tool: string;
  mcp?: string;
  name?: string;
  args?: Record<string, unknown>;
  severity?: HealthCheckSeverity;
  timeoutMs?: number;
};

/** Full value of a step's `healthChecks` field. */
type HealthChecks = HealthCheck[];

type SignalTypeStr = "string" | "number" | "boolean" | "object" | "array";

// Produces dot-notation paths for an object type up to 4 levels deep.
// Falls back to `string` for any, unknown, arrays, or primitives.
export type DotPaths<
  T,
  D extends readonly unknown[] = [],
> = D["length"] extends 4
  ? string
  : unknown extends T
    ? string
    : T extends readonly unknown[]
      ? string
      : T extends object
        ? {
            [K in keyof T & string]:
              | K
              | (NonNullable<T[K]> extends object
                  ? `${K}.${DotPaths<NonNullable<T[K]>, [...D, unknown]> & string}`
                  : never);
          }[keyof T & string]
        : string;

// Resolves the TypeScript type at a dot-notation path within T.
export type TypeAtPath<
  T,
  P extends string,
> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof NonNullable<T>
    ? TypeAtPath<NonNullable<NonNullable<T>[K]>, Rest>
    : unknown
  : P extends keyof NonNullable<T>
    ? NonNullable<T>[P]
    : unknown;

// Maps a TypeScript type to its signal type string.
type ToSignalType<T> = string extends T
  ? SignalTypeStr
  : [T] extends [string]
    ? "string"
    : [T] extends [number]
      ? "number"
      : [T] extends [boolean]
        ? "boolean"
        : [T] extends [readonly unknown[]]
          ? "array"
          : [T] extends [object]
            ? "object"
            : SignalTypeStr;

// A union of valid signal spec shapes keyed by sourcePath.
// When `type` is provided it must match the actual type at that path.
type SignalSpecInput<TOutput> = {
  [P in DotPaths<TOutput>]: {
    key?: string;
    sourcePath: P;
    type?: ToSignalType<TypeAtPath<TOutput, P>>;
    required?: boolean;
    availableWhenResultStatusIn?: string[] | null;
  };
}[DotPaths<TOutput>];

export type StepSignalSpec = {
  key?: string;
  sourcePath: string;
  type: SignalTypeStr;
  required?: boolean;
  availableWhenResultStatusIn?: string[] | null;
};

export type DefineStepInput<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
> = {
  key: string;
  name: string;
  description?: string | null;
  version?: number;
  agentPrompt:
    | string
    | ((context: PromptTemplateContext<TInput["_output"]>) => string);
  additionalInput?: TInput;
  result?: TResult;
  signals?: SignalSpecInput<TResult["_output"]>[];
  features?: AnyStepFeature[];
  mcpServers?: OpenCodeMcpServers | null;
  plugins?: OpenCodePlugins | null;
  healthChecks?: HealthChecks | null;
  status?: "draft" | "active";
  executionMode?: "workspace" | "no_workspace";
};

export type AdditionalStepInputLiteralBinding = {
  source: "literal";
  value: unknown;
};

export type AdditionalStepInputBinding =
  | {
      source: "work_item";
      field: string;
    }
  | AdditionalStepInputLiteralBinding;

export type StepDefinitionSpec = {
  key: string;
  name: string;
  description: string | null;
  version: number;
  kind: "user_defined";
  status: "draft" | "active" | "archived";
  executionMode?: "workspace" | "no_workspace";
  prompt: string | null;
  inputSchemaJson: Record<string, unknown> | null;
  resultSchemaJson: Record<string, unknown> | null;
  signalExtractorDefinitions: Array<{
    key: string;
    sourcePath: string;
    type: SignalTypeStr;
    required: boolean;
    availableWhenResultStatusIn: string[] | null;
  }>;
  opencodeMcpJson: OpenCodeMcpServers | null;
  opencodePluginJson: OpenCodePlugins | null;
  healthChecksJson: HealthChecks | null;
};

// Maps a signal type string literal to its TypeScript type.
export type SignalTypeStrToTs<T extends SignalTypeStr> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "array"
        ? unknown[]
        : T extends "object"
          ? object
          : unknown;

// Builds a map from signal key → TypeScript value type.
// Uses the explicit `type` field when present, otherwise resolves via TypeAtPath.
export type SignalTypeMapOf<TSignals extends readonly unknown[], TResult> = {
  [S in TSignals[number] as ExtractSignalKey<S>]: S extends {
    type: infer T extends SignalTypeStr;
  }
    ? SignalTypeStrToTs<T>
    : S extends { sourcePath: infer P extends string }
      ? TypeAtPath<TResult, P>
      : unknown;
};

// false when TInput is `unknown` (no additionalInput), true for concrete types, boolean for `any`.
type HasAdditionalInput<T> = 0 extends 1 & T
  ? boolean
  : [unknown] extends [T]
    ? false
    : true;

// Phantom-typed extension of StepDefinitionSpec carrying input/result/signal-key types.
// The phantom fields are never present at runtime — they exist only to thread type information
// into definePipeline. __hasAdditionalInput drives mapper-required vs optional overload selection.
export type TypedStepDefinitionSpec<
  TInput = unknown,
  TResult = unknown,
  TSignalKeys extends string = string,
  TSignalTypeMap extends Partial<Record<string, unknown>> = Record<
    string,
    unknown
  >,
> = StepDefinitionSpec & {
  readonly __inputType: TInput;
  readonly __hasAdditionalInput: HasAdditionalInput<TInput>;
  readonly __resultType: TResult;
  readonly __signalKeys: TSignalKeys;
  readonly __signalTypeMap: TSignalTypeMap;
};

// Infers the signal key from a single signal spec object:
// uses the explicit `key` if provided, otherwise falls back to `sourcePath`.
type ExtractSignalKey<T> = T extends { key: infer K extends string }
  ? K
  : T extends { sourcePath: infer S extends string }
    ? S
    : string;

// Unions all signal keys across a const-inferred signals tuple.
export type SignalKeysOf<TSignals extends readonly unknown[]> =
  TSignals extends readonly (infer S)[] ? ExtractSignalKey<S> : string;


export function defineStep<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  // The loose `sourcePath: string` constraint is what lets TypeScript infer and
  // preserve string literal types for `key` and `sourcePath`; narrowing it here
  // would widen them back to `string` and lose the signal-key typing that
  // `definePipeline` depends on. Validity against the result schema is enforced
  // instead by the intersection on `config.signals` below, which re-applies
  // `SignalSpecInput` — the constraint `Omit` strips off `DefineStepInput`.
  const TSignals extends ReadonlyArray<{ sourcePath: string; key?: string }> =
    never[],
  const TFeatures extends ReadonlyArray<AnyStepFeature> = never[],
>(
  config: Omit<DefineStepInput<TInput, TResult>, "signals" | "features"> & {
    signals?: TSignals & readonly SignalSpecInput<TResult["_output"]>[];
    features?: TFeatures;
  },
): TypedStepDefinitionSpec<
  TInput["_output"],
  TResult["_output"] & FeatureResultExtensions<TFeatures>,
  SignalKeysOf<TSignals> | FeatureSignalKeys<TFeatures>,
  SignalTypeMapOf<TSignals, TResult["_output"]>
> {
  const features = (config.features ?? []) as AnyStepFeature[];

  // Merge each feature's result extension into the base schema.
  let effectiveResult: ZodType | undefined = config.result;
  for (const feature of features) {
    effectiveResult = effectiveResult
      ? (effectiveResult as ZodObject<ZodRawShape>).extend(
          feature._resultExtension.shape,
        )
      : feature._resultExtension;
  }

  const basePrompt =
    typeof config.agentPrompt === "function"
      ? config.agentPrompt(createPromptTemplateContext<TInput["_output"]>())
      : config.agentPrompt;

  // Append each feature's prompt addition.
  let effectivePrompt: string = basePrompt;
  for (const feature of features) {
    if (feature._promptAddition) {
      effectivePrompt = effectivePrompt
        ? `${effectivePrompt}\n\n${feature._promptAddition}`
        : feature._promptAddition;
    }
  }

  // Collect user-defined signals, then append feature signals.
  const featureSignals = features.flatMap((f) => f._signals);

  const spec: StepDefinitionSpec = {
    key: config.key,
    name: config.name,
    description: config.description ?? null,
    version: config.version ?? 1,
    kind: "user_defined",
    status: config.status ?? "active",
    executionMode: config.executionMode,
    prompt: effectivePrompt,
    inputSchemaJson: config.additionalInput
      ? toJSONSchema(config.additionalInput as unknown as $ZodType)
      : null,
    resultSchemaJson: effectiveResult
      ? toJSONSchema(effectiveResult as unknown as $ZodType)
      : null,
    signalExtractorDefinitions: [
      ...((config.signals ?? []) as Array<{ key?: string; sourcePath: string; type?: SignalTypeStr; required?: boolean; availableWhenResultStatusIn?: string[] | null }>).map((s) => ({
        key: s.key ?? s.sourcePath,
        sourcePath: s.sourcePath,
        type:
          s.type ??
          zodTypeToSignalType(
            resolveZodSchemaAtPath(effectiveResult, s.sourcePath),
          ) ??
          "string",
        required: s.required ?? true,
        availableWhenResultStatusIn: s.availableWhenResultStatusIn ?? null,
      })),
      ...featureSignals.map((s) => ({
        key: s.key,
        sourcePath: s.sourcePath,
        type: s.type,
        required: s.required ?? true,
        availableWhenResultStatusIn: s.availableWhenResultStatusIn ?? null,
      })),
    ],
    opencodeMcpJson: config.mcpServers ?? null,
    opencodePluginJson: config.plugins ?? null,
    healthChecksJson: config.healthChecks ?? null,
  };
  return spec as TypedStepDefinitionSpec<
    TInput["_output"],
    TResult["_output"] & FeatureResultExtensions<TFeatures>,
    SignalKeysOf<TSignals> | FeatureSignalKeys<TFeatures>,
    SignalTypeMapOf<TSignals, TResult["_output"]>
  >;
}
