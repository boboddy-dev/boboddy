import type { ZodType } from "zod";
import type { PipelineInputBinding } from "./define-pipeline";

const ACCESSOR_BRAND: unique symbol = Symbol.for("boboddy.inputAccessor.brand");
const ACCESSOR_PATH: unique symbol = Symbol.for("boboddy.inputAccessor.path");

type DeepAccessor<T> = T extends ReadonlyArray<infer U>
  ? { readonly [index: number]: InputAccessor<U> }
  : T extends object
    ? { readonly [K in keyof T]: InputAccessor<T[K]> }
    : object;

/**
 * Type-level shape of the input accessor. Claims to be a `PipelineInputBinding`
 * so it slots into binding positions for type-checking; the actual binding
 * object is produced at builder time via `materializeAccessor`.
 */
export type InputAccessor<T> = PipelineInputBinding & DeepAccessor<T>;

/**
 * Creates a recursive proxy bound to the pipeline's input schema. Each property
 * access returns a new accessor whose `materializeAccessor()` yields a
 * `PipelineInputBinding` with the accumulated dot-path.
 *
 * The schema argument is used only for type inference — no runtime validation
 * is performed against it.
 */
export function createInputAccessor<T extends ZodType>(
  _schema: T,
): InputAccessor<T["_output"]> {
  return createProxy([]) as InputAccessor<T["_output"]>;
}

function createProxy(path: ReadonlyArray<string>): object {
  const pathStr = path.join(".");
  const target: object = Object.freeze({});

  return new Proxy(target, {
    get(_t, prop) {
      if (prop === ACCESSOR_BRAND) return true;
      if (prop === ACCESSOR_PATH) return pathStr;
      if (prop === "toJSON") {
        return (): PipelineInputBinding => ({
          source: "pipeline_input",
          path: pathStr,
        });
      }
      if (prop === Symbol.toPrimitive) {
        return () => {
          throw new Error(
            `Pipeline input accessor at path "${pathStr || "<root>"}" cannot be coerced to a primitive. ` +
              `Pass it to a step input field instead of using it in a string/number expression.`,
          );
        };
      }
      if (typeof prop === "symbol") return undefined;
      return createProxy([...path, prop]);
    },
    has(_t, prop) {
      return prop === ACCESSOR_BRAND || prop === ACCESSOR_PATH;
    },
    ownKeys() {
      throw new Error(
        `Pipeline input accessor at path "${pathStr || "<root>"}" cannot be enumerated. ` +
          `Drill into specific fields instead of spreading the input.`,
      );
    },
    set() {
      throw new Error(
        `Pipeline input accessor at path "${pathStr || "<root>"}" is read-only.`,
      );
    },
  });
}

export function isInputAccessor(
  value: unknown,
): value is InputAccessor<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [ACCESSOR_BRAND]?: unknown })[ACCESSOR_BRAND] === true
  );
}

export function materializeAccessor(
  accessor: InputAccessor<unknown>,
): PipelineInputBinding {
  return {
    source: "pipeline_input",
    path: (accessor as unknown as { [ACCESSOR_PATH]: string })[ACCESSOR_PATH],
  };
}
