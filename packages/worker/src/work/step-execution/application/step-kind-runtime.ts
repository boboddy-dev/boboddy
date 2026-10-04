import { assertNever } from "../../../common/assert-never";
import type { StepDefinitionKind } from "../contracts/step-execution-contracts";

/**
 * Whether a step of this kind prompts an OpenCode agent, and so needs the
 * OpenCode server (and everything that exists only to support it) launched.
 * An allowlist, not `kind !== "code"`: adding a kind fails typecheck here until
 * its author decides.
 */
export function stepKindUsesAgent(kind: StepDefinitionKind): boolean {
  switch (kind) {
    case "user_defined":
    case "built_in":
      return true;
    case "code":
      return false;
    default:
      return assertNever(kind);
  }
}
