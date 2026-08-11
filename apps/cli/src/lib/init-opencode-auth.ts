import type { OpencodeProviderCredentialCheck } from "@boboddy/worker";
import type { EnsureOpencodeRuntimePort } from "./design-runtime";
import type { BaseReporter } from "./reporter-types";

/**
 * `boboddy init`'s OpenCode-auth gate.
 *
 * Shares its detection logic with `pipelines design`'s preflight
 * (`checkOpencodeProviderCredentials`): an `auth.json` entry (written by
 * `opencode auth login`) or one of the recognized provider API-key env vars
 * both count. Unlike design's UNHEALABLE stop — Boboddy cannot obtain a key on
 * the user's behalf — `init` heals this itself: with no credential found, it
 * provisions the runtime and runs `opencode auth login` attached to the
 * terminal, in place, instead of hard-stopping with an instructional error
 * and making the user re-run `init` afterwards.
 */

export interface InitOpencodeAuthPorts extends EnsureOpencodeRuntimePort {
  /** Does a usable OpenCode credential already exist (auth.json or env var)? */
  checkCredentials(): Promise<OpencodeProviderCredentialCheck>;
  /**
   * Run `opencode auth login` attached to the terminal. Resolves once the
   * user finishes (or quits) it. Throws if the terminal is not interactive,
   * or if the login process exits with a non-zero code.
   */
  runAuthLogin(launcherPath: string): Promise<void>;
}

/** Thrown when `opencode auth login` ran but no credential shows up afterward. */
export const AUTH_LOGIN_DID_NOT_COMPLETE_MESSAGE =
  "OpenCode auth login did not complete. Run `boboddy init` again once you " +
  "have signed in, or export a provider API key such as ANTHROPIC_API_KEY " +
  "before re-running.";

export async function ensureOpencodeAuth(input: {
  reporter: BaseReporter;
  ports: InitOpencodeAuthPorts;
}): Promise<void> {
  const { reporter, ports } = input;

  const check = await ports.checkCredentials();
  if (check.ok) {
    reporter.success(`OpenCode auth ready (${check.providers.join(", ")})`);
    return;
  }

  reporter.info(
    "No OpenCode credentials found. Launching `opencode auth login`…",
  );
  const launcherPath = await ports.ensureRuntime();
  await ports.runAuthLogin(launcherPath);

  const recheck = await ports.checkCredentials();
  if (!recheck.ok) {
    throw new Error(AUTH_LOGIN_DID_NOT_COMPLETE_MESSAGE);
  }
  reporter.success(`OpenCode auth ready (${recheck.providers.join(", ")})`);
}
