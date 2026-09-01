/**
 * Restores the generic `NodeJS.Process#off` overload that `bun-types@1.4.0`
 * inadvertently shadows.
 *
 * `bun-types/overrides.d.ts` augments `NodeJS.Process` with a narrow
 * `off(event: "memoryPressure", listener: (level: "warning" | "critical") =>
 * void): this` overload for Bun's new memory-pressure event. `@types/node`
 * never declares its own `off` directly on `Process` — it only inherits the
 * generic `off` from `NodeJS.EventEmitter` — so once bun-types' declaration
 * merges in, its single narrow overload becomes the *only* `off` member
 * TypeScript sees directly on `Process` (an interface's own declared member
 * always replaces, rather than unions with, a same-named inherited member).
 * That breaks every ordinary `process.off(signal, listener)` call in the
 * codebase.
 *
 * This re-adds the same permissive fallback `@types/node` already uses as
 * the last overload of `Process#on`, so `process.off` keeps accepting any
 * event name again. Safe to delete once upstream `bun-types` ships a fix
 * that keeps a generic `off` overload alongside the `"memoryPressure"` one.
 */
declare global {
  namespace NodeJS {
    interface Process {
      off(event: string | symbol, listener: (...args: any[]) => void): this;
    }
  }
}

export {};
