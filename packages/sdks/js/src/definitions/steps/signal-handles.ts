/**
 * Typed references to a step's signals (`step.signals.<key>`). A handle
 * carries the step's key and the signal's key so other definitions can
 * point at a signal without repeating either string.
 */
export type StepSignalHandle<
  TSignalKey extends string = string,
  TValue = unknown,
> = {
  readonly stepKey: string;
  readonly signalKey: TSignalKey;
  /** Phantom: the signal's value type. Never present at runtime. */
  readonly __value?: TValue;
};

export type StepSignalHandles<
  TSignalKeys extends string,
  TSignalTypeMap extends Partial<Record<string, unknown>>,
> = {
  readonly [K in TSignalKeys]: StepSignalHandle<
    K,
    K extends keyof TSignalTypeMap ? TSignalTypeMap[K] : unknown
  >;
};

/**
 * Attaches `signals` to a built spec as a non-enumerable property, so it is
 * never serialised, pushed or compared as part of the spec's wire shape.
 */
export function attachSignalHandles<
  TSpec extends {
    key: string;
    signalExtractorDefinitions: ReadonlyArray<{ key: string }>;
  },
>(spec: TSpec): TSpec {
  const handles: Record<string, StepSignalHandle> = {};
  for (const signal of spec.signalExtractorDefinitions) {
    handles[signal.key] = Object.freeze({
      stepKey: spec.key,
      signalKey: signal.key,
    });
  }
  Object.defineProperty(spec, "signals", {
    value: Object.freeze(handles),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return spec;
}
