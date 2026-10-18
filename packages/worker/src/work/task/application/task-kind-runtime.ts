import { assertNever } from "../../../common/assert-never";
import type { TaskKind } from "../contracts/task-contracts";

/**
 * Whether a task of this kind prompts an OpenCode agent, and so needs the
 * OpenCode server (and everything that exists only to support it) launched.
 * An exhaustive switch, not `kind !== "code"`: adding a kind fails typecheck
 * here until its author decides.
 */
export function taskKindUsesAgent(kind: TaskKind): boolean {
  switch (kind) {
    case "agent":
      return true;
    case "code":
      return false;
    default:
      return assertNever(kind);
  }
}
