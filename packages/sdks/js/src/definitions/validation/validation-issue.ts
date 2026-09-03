// `DefinitionValidationIssue` + tiny message-formatting helpers shared by
// every check file (`validate-definition-specs.ts`'s original four checks,
// `validate-input-bindings.ts`'s Phase 2 binding-shape checks). Split out on
// its own so those two files can share the type without importing from each
// other — `validate-definition-specs.ts` calls into
// `validate-input-bindings.ts`'s check functions (to keep either file under
// the repo's `max-lines` limit), so the shared type can't live in whichever
// of the two would otherwise need to import the other.

export type DefinitionValidationIssue = {
  readonly check:
    | "signal-source-path"
    | "route-target"
    | "signal-binding"
    | "health-check-mcp-server"
    | "health-check-double-qualified"
    | "unbound-required-input"
    | "binding-target-field"
    | "binding-type-mismatch";
  /**
   * Whether this issue blocks a push. The 4 original checks are all
   * unconditionally `"error"`, matching their implicit all-blocking
   * behavior before this field existed. `"binding-type-mismatch"` is a
   * `"warning"`-tier check — a resolved type disagreement is worth
   * surfacing but, per §4's own bias, never provably a runtime failure the
   * way an unresolved binding or a missing required input is.
   * `"binding-target-field"`'s "unbound field name isn't a declared
   * `additionalInput`" sub-check is `"info"`-tier — passing extra context
   * a step doesn't declare as an `additionalInput` is allowed (the value is
   * just dropped), so it's worth surfacing for awareness but never rises to
   * even a warning. Only `assertValidDefinitionSpecs` treats these tiers
   * differently: it blocks a push on `"error"` alone.
   */
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  /**
   * The pipeline this issue belongs to, when the check is pipeline-scoped
   * (`route-target`/`signal-binding`/the three Phase 2 binding checks) —
   * absent for step-only checks (`signal-source-path`/`health-check-*`),
   * which have no pipeline context of their own. Required before the
   * designer (Phase 5) can attach an error to the right graph node.
   */
  readonly pipelineKey?: string;
  /** The node this issue is about, when pipeline-scoped. */
  readonly nodeKey?: string;
  /**
   * A second, related node this issue is about — e.g. `signal-binding`'s
   * producer node, when different from `nodeKey`'s consumer. Absent when
   * the issue is about a single node, or when the "other end" isn't a
   * node in this pipeline at all (`route-target`'s target is a different
   * *pipeline*, not a node).
   */
  readonly targetNodeKey?: string;
  /**
   * The specific `parallel` branch this issue is about, when `nodeKey`
   * names a `parallel` node — one of that node's `branches` keys. Set only
   * by the three Phase 2 binding checks (`unbound-required-input`/
   * `binding-target-field`/`binding-type-mismatch`) when the
   * `BindingContext` they're walking is a `parallel` branch's own bindings
   * (`bindingContexts`' `ctx.branchKey`), not the node's own bindings.
   * Absent for every other check, and absent for those three checks' own
   * non-`parallel` (`step`/`fanOut`/`loop`) cases — without this, issues
   * from two different branches of the same `parallel` node are
   * indistinguishable by branch.
   */
  readonly branchKey?: string;
};

/** Formats a path list for an error message, capped so it stays readable. */
export function listPaths(paths: readonly string[], limit = 24): string {
  if (paths.length === 0) return "";
  if (paths.length <= limit) return paths.join(", ");
  return `${paths.slice(0, limit).join(", ")}, … (${String(paths.length - limit)} more)`;
}
