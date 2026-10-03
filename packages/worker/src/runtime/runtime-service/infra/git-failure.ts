/**
 * A failed `git` invocation, carrying the full stderr so callers can classify
 * the failure. `exitCode` is the process exit status, or `null` when git never
 * ran to completion (spawn failure, timeout).
 */
export class GitCommandError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = "GitCommandError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Failures that point at the environment (network, auth, the remote, file
 * permissions) rather than at a damaged local repository. Any match vetoes a
 * corruption verdict: deleting a good mirror over a transient error is the
 * worst outcome, so ambiguity resolves to "not corrupt".
 */
const ENVIRONMENT_FAILURE_PATTERNS: readonly RegExp[] = [
  /could not resolve host/i,
  /connection (refused|reset|timed out)/i,
  /timed out/i,
  /authentication failed/i,
  /repository .*not found/i,
  /permission denied/i,
  /unable to access/i,
  /could not read from remote repository/i,
  /does not appear to be a git repository/i,
  /dubious ownership/i,
  /early eof/i,
  /rpc failed/i,
  /unexpected disconnect/i,
  /^ssh: /im,
];

const CORRUPTION_PATTERNS: readonly RegExp[] = [
  /\bnot a git repository\b/i,
  /\bbad (\w+ )?object\b/i,
  /\bis corrupt\b/i,
  /object file .* is empty/i,
  /unable to unpack .* header/i,
  /is not a git packfile/i,
  /does not point to a valid object/i,
  /\b(missing|broken) (blob|tree|commit|tag|object)\b/i,
];

/** True when `stderr` points at the environment rather than the repository. */
export function isEnvironmentFailure(stderr: string): boolean {
  return ENVIRONMENT_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * True when `stderr` shows the local repository itself is damaged. Lines the
 * remote prefixed with `remote:` are ignored: they describe the remote's
 * repository, not ours.
 */
export function isRepoCorruption(stderr: string): boolean {
  const local = stderr
    .split("\n")
    .filter((line) => !/^\s*remote:/i.test(line))
    .join("\n");
  if (isEnvironmentFailure(local)) {
    return false;
  }
  return CORRUPTION_PATTERNS.some((pattern) => pattern.test(local));
}
