import {
  isUninheritableWorkerEnvVarName,
  type EnvVarSpec,
} from "@boboddy/sdk/env-vars";
import { renderPromptTemplate } from "@boboddy/sdk/definitions/steps";

/**
 * Resolves a step's declared `envJson` against a run's input and the worker's
 * environment. Pure: the worker host's env (`.boboddy/.env` over `process.env`)
 * is passed in as `workerEnv`, never read here.
 *
 * - `value`: the template rendered against `{ input }`.
 * - `inherit`: `workerEnv[from]`, else `default`, else omitted when
 *   `optional`, else reported as missing.
 *
 * Every missing required name is collected into a single
 * {@link MissingStepEnvError}; its message names variables, never values.
 */

export type ResolvedStepEnv = {
  /** Every resolved variable, secret or not: what is injected into the run. */
  stepEnv: Record<string, string>;
  /** The non-secret subset, safe to render into the agent prompt. */
  promptEnv: Record<string, string>;
  /** Resolved values of secret entries, to register with the log masker. */
  secretValues: string[];
};

export class MissingStepEnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Step declares required environment variables that are not set on the worker: ${missing.join(", ")}. ` +
        "Set them in .boboddy/.env or the worker's environment, or mark them optional.",
    );
    this.name = "MissingStepEnvError";
    this.missing = missing;
  }
}

export function resolveStepEnv(input: {
  envJson: readonly EnvVarSpec[] | null | undefined;
  inputJson: unknown;
  workerEnv: Readonly<Record<string, string | undefined>>;
}): ResolvedStepEnv {
  const stepEnv: Record<string, string> = {};
  const promptEnv: Record<string, string> = {};
  const secretValues: string[] = [];
  const missing: string[] = [];

  for (const entry of input.envJson ?? []) {
    let resolved: string | undefined;

    if (entry.source === "value") {
      resolved = renderPromptTemplate(entry.value, { input: input.inputJson });
    } else {
      if (isUninheritableWorkerEnvVarName(entry.from)) {
        throw new Error(
          `Step env "${entry.name}" cannot inherit worker variable "${entry.from}": BOBODDY_* variables are reserved for the worker.`,
        );
      }
      resolved = input.workerEnv[entry.from] ?? entry.default;
      if (resolved === undefined) {
        if (!entry.optional) {
          missing.push(
            entry.from === entry.name
              ? entry.name
              : `${entry.from} (for ${entry.name})`,
          );
        }
        continue;
      }
    }

    stepEnv[entry.name] = resolved;
    if (entry.secret) {
      if (resolved.length > 0) secretValues.push(resolved);
    } else {
      promptEnv[entry.name] = resolved;
    }
  }

  if (missing.length > 0) throw new MissingStepEnvError(missing);

  return { stepEnv, promptEnv, secretValues };
}
