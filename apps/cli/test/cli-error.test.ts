import { describe, expect } from "bun:test";
import {
  ConfigurationError,
  CoreError,
  SetupErrorCodes,
} from "@boboddy/worker";
import { ProjectRefError } from "@boboddy/sdk/defaults";
import { CliError, classifyCliError } from "../src/lib/cli-error";
import { concurrentTest as test } from "./utils";

describe("classifyCliError", () => {
  test("returns a CliError's own code", () => {
    expect(
      classifyCliError(
        new CliError("no_package_manager", "No package manager"),
      ),
    ).toBe("no_package_manager");
  });

  test("maps worker setup errors by code, not message", () => {
    const cases = [
      [SetupErrorCodes.NotInGitRepository, "not_in_git_repo"],
      [SetupErrorCodes.NoOriginRemote, "no_origin_remote"],
      [SetupErrorCodes.NotSignedIn, "not_signed_in_noninteractive"],
      [SetupErrorCodes.NoInteractiveTerminal, "no_tty"],
      [SetupErrorCodes.DeviceLoginExpired, "device_login_expired"],
      [SetupErrorCodes.DeviceLoginDenied, "device_login_denied"],
      [SetupErrorCodes.DeviceLoginFailed, "device_login_failed"],
      [SetupErrorCodes.NoOwnerUsername, "no_owner_username"],
    ] as const;

    for (const [workerCode, cliCode] of cases) {
      expect(
        classifyCliError(new ConfigurationError("any wording", workerCode)),
      ).toBe(cliCode);
    }
  });

  test("maps a project ref failure by its kind", () => {
    expect(
      classifyCliError(
        new ProjectRefError(
          "forbidden",
          "acme/web-app",
          "You don't have permission",
        ),
      ),
    ).toBe("project_forbidden");
    expect(
      classifyCliError(
        new ProjectRefError("not_found", "acme/web-app", "No project"),
      ),
    ).toBe("project_not_found");
  });

  test("follows the cause chain of a wrapping error", () => {
    const wrapped = new Error("Run `boboddy pipelines design` again.", {
      cause: new CliError("run_queue_failed", "Could not queue the run"),
    });
    expect(classifyCliError(wrapped)).toBe("run_queue_failed");
  });

  test("reports unknown for unclassified errors and non-errors", () => {
    expect(classifyCliError(new Error("boom"))).toBe("unknown");
    expect(
      classifyCliError(
        new CoreError({ code: "SOMETHING_ELSE", message: "x", status: 500 }),
      ),
    ).toBe("unknown");
    expect(classifyCliError(new ConfigurationError("generic"))).toBe("unknown");
    expect(classifyCliError("a string")).toBe("unknown");
    expect(classifyCliError(undefined)).toBe("unknown");
  });
});
