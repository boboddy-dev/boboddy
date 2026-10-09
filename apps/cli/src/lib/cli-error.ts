import { CoreError, SetupErrorCodes } from "@boboddy/worker";

/**
 * Every early exit of the onboarding commands (`init`, `pipelines design`,
 * `pipelines push`), as reported on `cli_command_failed`. A closed vocabulary
 * so failure-mix dashboards group cleanly; the human-readable message is never
 * sent, since it can carry local paths or remote URLs.
 */
export const CLI_ERROR_CODES = [
  "not_in_git_repo",
  "no_origin_remote",
  "not_signed_in_noninteractive",
  "device_login_expired",
  "device_login_denied",
  "device_login_failed",
  "runtime_download_failed",
  "no_tty",
  "opencode_login_failed",
  "project_handoff_unresolved",
  "project_handoff_noninteractive",
  "no_project_id",
  "no_work_item",
  "work_item_create_failed",
  "no_package_manager",
  "builder_install_failed",
  "run_queue_failed",
  "push_failed",
  "designer_exited_nonzero",
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

/** A CLI-owned failure carrying its {@link CliErrorCode}. */
export class CliError extends Error {
  public constructor(
    public readonly code: CliErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

const CODE_BY_WORKER_CODE: Record<
  (typeof SetupErrorCodes)[keyof typeof SetupErrorCodes],
  CliErrorCode
> = {
  [SetupErrorCodes.NotInGitRepository]: "not_in_git_repo",
  [SetupErrorCodes.NoOriginRemote]: "no_origin_remote",
  [SetupErrorCodes.NotSignedIn]: "not_signed_in_noninteractive",
  [SetupErrorCodes.NoInteractiveTerminal]: "no_tty",
  [SetupErrorCodes.DeviceLoginExpired]: "device_login_expired",
  [SetupErrorCodes.DeviceLoginDenied]: "device_login_denied",
  [SetupErrorCodes.DeviceLoginFailed]: "device_login_failed",
};

const isWorkerSetupCode = (
  code: string,
): code is keyof typeof CODE_BY_WORKER_CODE => code in CODE_BY_WORKER_CODE;

const MAX_CAUSE_DEPTH = 5;

/**
 * The {@link CliErrorCode} for a thrown value: a {@link CliError}'s own code,
 * or the mapped code of a worker setup error (matched on its `code`, never its
 * message). Follows `cause` so a wrapped failure keeps its classification.
 */
// eslint-disable-next-line local/no-unknown-parameter-type -- error boundary: caught values are `unknown`
export function classifyCliError(error: unknown): CliErrorCode | "unknown" {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof CliError) {
      return current.code;
    }
    if (current instanceof CoreError && isWorkerSetupCode(current.code)) {
      return CODE_BY_WORKER_CODE[current.code];
    }
    if (!(current instanceof Error)) {
      return "unknown";
    }
    current = current.cause;
  }
  return "unknown";
}
