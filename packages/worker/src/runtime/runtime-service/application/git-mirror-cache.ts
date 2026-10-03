/**
 * Structural subset of the work logger so `runtime-service` does not import
 * from `work/`. `ProjectWorkLogger` satisfies it.
 */
export type GitCacheLogger = {
  log(scope: string, message: string, details?: Record<string, unknown>): void;
};

/**
 * `hit`: an existing mirror was refreshed. `miss`: the mirror was built from
 * scratch, either first-time creation or a corrupt mirror recreated.
 */
export type MirrorOutcome = "hit" | "miss";

export type PreparedMirror = {
  mirrorPath: string;
  outcome: MirrorOutcome;
  release(): Promise<void>;
};

export type PrepareMirrorOptions = {
  logger?: GitCacheLogger | undefined;
};

/**
 * A persistent bare mirror of a remote, refreshed on demand.
 *
 * `prepare` returns a fresh, ready-to-clone mirror and the caller must call
 * `release()` in a `finally` once its local clone is done. `null` means "use
 * the plain clone": the reason has already been logged.
 */
export type GitMirrorCache = {
  prepare(
    gitUrl: string,
    options: PrepareMirrorOptions,
  ): Promise<PreparedMirror | null>;
};
