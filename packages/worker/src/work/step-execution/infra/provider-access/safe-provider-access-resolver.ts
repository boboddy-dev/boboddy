import type {
  ProviderAccess,
  ProviderAccessResolver,
  ResolveProviderAccessInput,
} from "../../contracts/agent-runtime/provider-access-resolver";

/**
 * Decorates a {@link ProviderAccessResolver} so resolution failures never abort
 * the caller: instead of throwing, `resolve()` returns an empty `{ mode:
 * "direct" }` access (which the session materializer turns into `{ env: {} }`
 * without error — see `SessionRuntimeConfigMaterializer.materialize`) and
 * records the failure on {@link lastError} for the caller to inspect.
 *
 * Built for `runWorkDryRun`: unlike a real step execution, a dry run should
 * still bring up the container/OpenCode process and report container + MCP
 * health even when no provider credential is configured yet — that is often
 * exactly the problem an onboarding user is trying to diagnose, not a reason
 * to abort before the diagnostic runs.
 *
 * Not used on the real step-execution path: production launches must still
 * fail fast when no provider access can be resolved.
 */
export class SafeProviderAccessResolver implements ProviderAccessResolver {
  /**
   * The error from the most recent {@link resolve} call, or `null` if it
   * succeeded. Inspect this AFTER awaiting `resolve()` to know whether the
   * returned access is a real resolution or the empty fallback.
   */
  lastError: Error | null = null;

  constructor(private readonly inner: ProviderAccessResolver) {}

  async resolve(input: ResolveProviderAccessInput): Promise<ProviderAccess> {
    try {
      const access = await this.inner.resolve(input);
      this.lastError = null;
      return access;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      return { mode: "direct" };
    }
  }
}
