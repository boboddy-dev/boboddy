import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import type { BaseReporter } from "./reporter-types";

/**
 * The AI-provider step of `boboddy init`.
 *
 * `init` used to gate on an OpenCode provider credential: with none found it
 * downloaded the runtime and spawned `opencode auth login` before the project
 * was even linked. That connect step now lives in the `pipelines design`
 * preflight (`lib/design-provider-connect.ts`), right before the thing that
 * needs it. `init` only reports what it found, so a user who declines the
 * designer never pays for the download or a third-party login.
 *
 * The check reads provider names only and needs no runtime, so this step never
 * downloads anything. It sits behind {@link ProviderNoticePorts} so every
 * branch is unit-testable without a home directory.
 */

export interface ProviderNoticePorts {
  /** Is any AI provider credential already usable by OpenCode? */
  checkCredentials(): Promise<OpencodeProviderCredentialCheck>;
}

/** Spinner copy while the check runs. */
export const PROVIDER_TASK_LABEL = "Checking AI provider…";

/** Resolved task copy when a provider is already connected. */
export const PROVIDER_PRESENT_LABEL = (providers: readonly string[]): string =>
  `AI provider ready (${providers.join(", ")})`;

/**
 * Resolved task copy when none is connected. A statement of fact, not a
 * failure: on a first run this is the expected answer.
 */
export const PROVIDER_MISSING_LABEL = "No AI provider connected yet";

/** The notice: says what will connect a provider and when, so there is nothing to do now. */
export const PROVIDER_NOTICE_MESSAGE =
  "The pipeline designer runs on OpenCode and connects it to a model the first time it starts — nothing to do now.";

/**
 * Report whether an AI provider is connected, as a notice rather than a gate.
 * Returns the answer so callers can branch; only a failed *check* throws.
 */
export async function reportProviderStatus(input: {
  reporter: BaseReporter;
  ports: ProviderNoticePorts;
}): Promise<{ connected: boolean }> {
  const { reporter, ports } = input;

  const task = reporter.startTask(PROVIDER_TASK_LABEL);
  let check: OpencodeProviderCredentialCheck;
  try {
    check = await ports.checkCredentials();
  } catch (error) {
    task.fail("AI provider check failed");
    throw error;
  }

  if (check.ok) {
    task.succeed(PROVIDER_PRESENT_LABEL(check.providers));
    return { connected: true };
  }

  task.succeed(PROVIDER_MISSING_LABEL);
  reporter.info(PROVIDER_NOTICE_MESSAGE);
  return { connected: false };
}
