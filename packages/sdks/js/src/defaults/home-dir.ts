import { homedir } from "node:os";

// `os.homedir()` is resolved by the runtime at ITS OWN startup (confirmed
// against Bun: mutating `process.env.HOME`/`USERPROFILE` afterward, or
// mocking `node:os`, does NOT change what `homedir()` returns), so this
// explicit hook is the only reliable way to redirect these modules at a
// scratch directory from within a running test process.
let homeDirOverrideForTests: string | undefined;

/** Test-only. Redirects every read/write path derived from `resolveHomeDir`. */
export function setHomeDirForTests(dir: string | undefined): void {
  homeDirOverrideForTests = dir;
}

export function resolveHomeDir(): string {
  return homeDirOverrideForTests ?? homedir();
}
