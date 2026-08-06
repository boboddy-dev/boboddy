import type { BaseReporter } from "./reporter-types";

/**
 * The devcontainer step of `boboddy init`.
 *
 * Boboddy runs every step inside the project's devcontainer, so `init` used to
 * require one and throw when it was absent. That inverted the onboarding order:
 * the abort landed before the designer handoff, and the design session is the one
 * thing that can author a devcontainer. A repo without one was told to go and
 * write it by hand before it was allowed to continue.
 *
 * So the requirement is now a notice. `init` still looks, still says what it
 * found, and hands over — the design session writes the config, and the first
 * pipeline run is what verifies it builds.
 *
 * The check sits behind {@link DevcontainerNoticePorts} so both branches are
 * unit-testable without a repository on disk.
 */

export interface DevcontainerNoticePorts {
  /** Does this repository already carry a devcontainer config? */
  hasDevcontainer(): Promise<boolean>;
}

/** Spinner copy while the check runs. */
export const DEVCONTAINER_TASK_LABEL = "Checking devcontainer…";

/** Resolved task copy when one already exists. */
export const DEVCONTAINER_PRESENT_LABEL = "Devcontainer ready";

/**
 * Resolved task copy when none exists. Deliberately a statement of fact rather
 * than a failure: `init` completed this step successfully by determining that
 * there is nothing here yet.
 */
export const DEVCONTAINER_MISSING_LABEL = "No devcontainer yet";

/**
 * The notice itself. It names what will create the file and when, so the user
 * has nothing to do — the opposite of the old error, which asked them to author
 * a devcontainer by hand and re-run `init`.
 */
export const DEVCONTAINER_NOTICE_MESSAGE =
  "Boboddy runs every step inside your project's devcontainer, and this " +
  "repository does not have one yet. Nothing to do: `boboddy pipelines design` " +
  "will write a `.devcontainer/devcontainer.json` during the session, and your " +
  "first pipeline run is what verifies it builds.";

/**
 * Report whether the repository has a devcontainer, as a notice rather than a
 * gate. Returns the answer so callers can branch; only a failed *check* throws.
 */
export async function reportDevcontainerStatus(input: {
  reporter: BaseReporter;
  ports: DevcontainerNoticePorts;
}): Promise<{ present: boolean }> {
  const { reporter, ports } = input;

  const task = reporter.startTask(DEVCONTAINER_TASK_LABEL);
  let present: boolean;
  try {
    present = await ports.hasDevcontainer();
  } catch (error) {
    // A missing devcontainer is a notice; a filesystem that cannot answer the
    // question is a real failure and must not be reported as "none found".
    task.fail("Devcontainer check failed");
    throw error;
  }

  if (present) {
    task.succeed(DEVCONTAINER_PRESENT_LABEL);
    return { present: true };
  }

  task.succeed(DEVCONTAINER_MISSING_LABEL);
  reporter.warn(DEVCONTAINER_NOTICE_MESSAGE);
  return { present: false };
}
