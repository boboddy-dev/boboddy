/**
 * Exhaustiveness guard for `switch` statements over a closed union: passing the
 * narrowed-to-`never` value fails typecheck as soon as a new member is added
 * without a matching case, and throws if an unexpected value arrives at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
