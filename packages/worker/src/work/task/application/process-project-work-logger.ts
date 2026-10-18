import type {
  ProcessProjectWorkDeps,
  ProjectWorkLogger,
  WorkReporter,
} from "../contracts/process-project-work-types";
import { noopReporter } from "../contracts/work-reporter";

export const noopProjectWorkLogger: ProjectWorkLogger = {
  debug: () => undefined,
  log: () => undefined,
  error: () => undefined,
};

export function resolveProjectWorkLogger(
  deps: Pick<ProcessProjectWorkDeps, "logger">,
): ProjectWorkLogger {
  return deps.logger ?? noopProjectWorkLogger;
}

export function resolveProjectWorkReporter(
  deps: Pick<ProcessProjectWorkDeps, "reporter">,
): WorkReporter {
  return deps.reporter ?? noopReporter;
}
