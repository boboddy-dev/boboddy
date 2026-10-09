type CoreErrorInput = {
  code: string;
  message: string;
  status: number;
  expose?: boolean;
  meta?: Record<string, unknown> | undefined;
};

const toResourceCodePrefix = (resource: string) => {
  let result = "";
  let previousWasUnderscore = false;

  for (const character of resource.trim()) {
    const isAlphaNumeric =
      (character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      (character >= "0" && character <= "9");

    if (isAlphaNumeric) {
      result += character.toUpperCase();
      previousWasUnderscore = false;
      continue;
    }

    if (!previousWasUnderscore && result.length > 0) {
      result += "_";
      previousWasUnderscore = true;
    }
  }

  return previousWasUnderscore ? result.slice(0, -1) : result;
};

export class CoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly expose: boolean;
  readonly meta: Record<string, unknown> | undefined;

  constructor({ code, message, status, expose = true, meta }: CoreErrorInput) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.expose = expose;
    this.meta = meta;
  }
}

export class CoreValidationError extends CoreError {
  constructor(
    message: string,
    code = "VALIDATION_ERROR",
    meta?: Record<string, unknown>,
  ) {
    super({
      code,
      message,
      status: 422,
      meta,
    });
  }
}

export class ResourceNotFoundError extends CoreError {
  constructor(resource: string, identifier: string) {
    super({
      code: `${toResourceCodePrefix(resource)}_NOT_FOUND`,
      message: `${resource} ${identifier} not found`,
      status: 404,
      meta: {
        resource,
        identifier,
      },
    });
  }
}

export class ResourceConflictError extends CoreError {
  constructor(resource: string, identifier: string) {
    super({
      code: `${toResourceCodePrefix(resource)}_CONFLICT`,
      message: `${resource} ${identifier} already exists`,
      status: 409,
      meta: {
        resource,
        identifier,
      },
    });
  }
}

export class ResourceOwnershipError extends CoreError {
  constructor(resource: string, identifier: string, message?: string) {
    super({
      code: `${toResourceCodePrefix(resource)}_OWNERSHIP_CONFLICT`,
      message: message ?? `${resource} ${identifier} is not owned by the caller`,
      status: 409,
      meta: {
        resource,
        identifier,
      },
    });
  }
}

export class InvariantViolationError extends CoreError {
  constructor(message: string, code = "INVARIANT_VIOLATION") {
    super({
      code,
      message,
      status: 500,
      expose: false,
    });
  }
}

export class PersistenceError extends CoreError {
  constructor(message: string, code = "PERSISTENCE_ERROR") {
    super({
      code,
      message,
      status: 500,
      expose: false,
    });
  }
}

export class ConfigurationError extends CoreError {
  constructor(message: string, code = "CONFIGURATION_ERROR") {
    super({
      code,
      message,
      status: 500,
      expose: false,
    });
  }
}

export type ExpectedCoreError =
  | ResourceNotFoundError
  | ResourceConflictError
  | ResourceOwnershipError
  | CoreValidationError;

/**
 * Stable codes for the setup failures `boboddy init` / `pipelines design`
 * report as `cli_command_failed`. Thrown errors carry one as their `code`, so
 * the CLI classifies them by code rather than by matching message text.
 */
export const SetupErrorCodes = {
  NotInGitRepository: "NOT_IN_GIT_REPOSITORY",
  NoOriginRemote: "NO_ORIGIN_REMOTE",
  NotSignedIn: "NOT_SIGNED_IN",
  NoInteractiveTerminal: "NO_INTERACTIVE_TERMINAL",
  DeviceLoginExpired: "DEVICE_LOGIN_EXPIRED",
  DeviceLoginDenied: "DEVICE_LOGIN_DENIED",
  DeviceLoginFailed: "DEVICE_LOGIN_FAILED",
} as const;
