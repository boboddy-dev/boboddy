/**
 * `NodeDefinitionSpec`'s step-only fields (`advancementPolicyDefinition`,
 * `computedSignalDefinitions`, ...) became optional at the type level when
 * `kind` widened to include `fanOut`/`cohortGate` (issue #167) — every node
 * built by these tests is a real `kind: "step"` node where the field is
 * always present at runtime, so this guard (not a non-null assertion,
 * which this repo's lint config forbids) is purely a type narrowing.
 */
export function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label}`);
  return value;
}
