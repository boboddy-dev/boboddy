import { toJSONSchema } from "zod/v4/core";
import type { $ZodType } from "zod/v4/core";
import type { ZodObject, ZodRawShape, ZodType } from "zod";
import type {
  AnyStepFeature,
  FeatureResultExtensions,
  FeatureSignalKeys,
} from "./step-features";
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
  agentPrompt: string;
  additionalInput?: TInput;
  result?: TResult;
  signals?: SignalSpecInput<TResult["_output"]>[];
  features?: AnyStepFeature[];
  mcpServers?: OpenCodeMcpServers | null;
  status?: "draft" | "active";
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

// Structural type for Zod v4's internal _def — avoids `any` while accessing private internals.
// In Zod v4: _def.type uses lowercase strings, shape is a plain object (not a function).
type ZodInternal = {
  _def: {
    type: string;
    innerType?: ZodInternal;
    shape?: Record<string, ZodInternal>;
  };
};

const UNWRAP_TYPES = new Set(["optional", "nullable", "default"]);

function unwrapZodType(schema: ZodInternal): ZodInternal {
  while (UNWRAP_TYPES.has(schema._def.type)) {
    const inner = schema._def.innerType;
    if (!inner) break;
    schema = inner;
  }
  return schema;
}

function deriveSignalType(
  schema: ZodType | undefined,
  path: string,
): SignalTypeStr {
  if (!schema) return "string";

  let current = unwrapZodType(schema as ZodInternal);

  for (const part of path.split(".")) {
    if (current._def.type !== "object") return "string";
    const next = current._def.shape?.[part];
    if (!next) return "string";
    current = unwrapZodType(next);
  }

  switch (current._def.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
    case "record":
      return "object";
    default:
      return "string";
  }
}

export function defineStep<
  TInput extends ZodType = ZodType,
  TResult extends ZodType = ZodType,
  // Simpler constraint lets TypeScript preserve string literal types for `key` and `sourcePath`.
  // The intersection in the config type enforces validity against the result schema.
  const TSignals extends ReadonlyArray<{ sourcePath: string; key?: string }> =
    never[],
  const TFeatures extends ReadonlyArray<AnyStepFeature> = never[],
>(
  config: Omit<DefineStepInput<TInput, TResult>, "signals" | "features"> & {
    signals?: TSignals;
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

  // Append each feature's prompt addition.
  let effectivePrompt: string = config.agentPrompt;
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
    prompt: effectivePrompt,
    inputSchemaJson: config.additionalInput
      ? toJSONSchema(config.additionalInput as unknown as $ZodType)
      : null,
    resultSchemaJson: effectiveResult
      ? toJSONSchema(effectiveResult as unknown as $ZodType)
      : null,
    signalExtractorDefinitions: [
      ...((config.signals ?? []) as StepSignalSpec[]).map((s) => ({
        key: s.key ?? s.sourcePath,
        sourcePath: s.sourcePath,
        type: s.type ?? deriveSignalType(config.result, s.sourcePath),
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
  };
  return spec as TypedStepDefinitionSpec<
    TInput["_output"],
    TResult["_output"] & FeatureResultExtensions<TFeatures>,
    SignalKeysOf<TSignals> | FeatureSignalKeys<TFeatures>,
    SignalTypeMapOf<TSignals, TResult["_output"]>
  >;
}
