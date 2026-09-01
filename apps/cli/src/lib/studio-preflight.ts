import { PIPELINE_BUILDER_DIR } from "@boboddy/worker";
import type { BaseReporter } from "./reporter-types";

/**
 * The preflight for `boboddy pipelines studio` — deliberately much lighter
 * than `pipelines design`'s (`design-preflight.ts`). That command is about
 * to launch an authenticated agent session against a real project, so it
 * resolves a session, a project id, and a work item. The studio is
 * explicitly local-only (see docs/research/flat-pipeline-sdk-and-visual-designer.md
 * §10: "no network call") — it never needs to talk to the server at all, so
 * this preflight only confirms/scaffolds the one thing it genuinely depends
 * on: `.boboddy/pipeline-builder` existing with its dependencies installed
 * (`collectDefinitionsFromDirectory` dynamically imports every file in it,
 * which needs `@boboddy/sdk` resolvable — the same precondition
 * `pipelines push` already checks and fails the same way for).
 */

export interface StudioPreflightPorts {
  /** Does `.boboddy/pipeline-builder` already exist? */
  builderDirExists(): boolean;
  /**
   * Create it. Throws when the current directory is not a plausible project
   * root — see `assertProjectRoot` in `pipelines-studio.ts`.
   */
  scaffoldBuilderDir(): void;
  /** Is `@boboddy/sdk` resolvable from inside the builder directory? */
  dependenciesInstalled(): boolean;
}

export const MISSING_DEPENDENCIES_MESSAGE =
  `Missing dependencies in ${PIPELINE_BUILDER_DIR}. ` +
  "Run `bun install` / `npm install` / `pnpm install` / `yarn install` " +
  "inside that directory first.";

/**
 * Ensures the builder directory exists (scaffolding it when missing) and its
 * dependencies are installed. Unlike `pipelines design`'s preflight, a
 * missing install is NOT healed automatically here — running an installer
 * without being asked is a heavier side effect than a read-only, local-only
 * command should take silently; the error message tells the user the exact
 * command to run themselves, matching `pipelines push`'s existing behavior.
 */
export function runStudioPreflight(input: {
  reporter: BaseReporter;
  ports: StudioPreflightPorts;
}): void {
  const { reporter, ports } = input;

  if (ports.builderDirExists()) {
    reporter.success("Pipeline builder directory ready");
  } else {
    ports.scaffoldBuilderDir();
    reporter.success("Scaffolded the pipeline builder directory");
  }

  if (!ports.dependenciesInstalled()) {
    throw new Error(MISSING_DEPENDENCIES_MESSAGE);
  }
}
