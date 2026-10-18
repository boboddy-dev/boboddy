import {
  listOpencodeAuthProviders,
  type ListOpencodeAuthProvidersInput,
} from "../../../work/task/infra/provider-access/opencode-credential-discovery";

/**
 * Pre-flight check for the interactive OpenCode TUI: does the user have any AI
 * provider credential the TUI can actually use?
 *
 * Uses the same credential source the step runtime injects from
 * (`opencode-credential-source.ts`): the pinned runtime's
 * `auth export --standalone` (written by `auth login`), a v1 `auth.json`, and
 * the well-known provider API-key env vars.
 *
 * PRIVACY: only provider NAMES are read, returned, or logged. Token values,
 * key material, and env var VALUES never leave the credential source.
 */

/** Discriminated result of {@link checkOpencodeProviderCredentials}. */
export type OpencodeProviderCredentialCheck =
  | {
      ok: true;
      /** Sorted, de-duplicated provider names. Never contains secrets. */
      providers: string[];
    }
  | {
      ok: false;
      /** Human-readable, copy-pasteable instructions to fix the problem. */
      remediation: string;
    };

export type CheckOpencodeProviderCredentialsInput = {
  /**
   * Absolute path of the provisioned OpenCode launcher (`launch.sh`). Runs the
   * credential export and builds the remediation command — the user may not
   * have `opencode` on PATH at all, so we always point at the binary Boboddy
   * provisioned.
   *
   * Optional: a caller that only needs the yes/no answer can omit it rather
   * than provision the runtime just to ask the question — `boboddy init` does
   * exactly that. The export then uses an already-provisioned runtime if there
   * is one, and otherwise only `auth.json` and env are consulted.
   */
  launcherPath?: string | undefined;
  /** Host home dir override (tests). Defaults to `HOME`/`os.homedir()`. */
  homeDir?: string | undefined;
  /** Env override (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Injected credential loader (tests). */
  loadCredentials?: ListOpencodeAuthProvidersInput["loadCredentials"];
};

/**
 * Resolve whether any usable provider credential exists, or the remediation the
 * user should follow.
 */
export async function checkOpencodeProviderCredentials(
  input: CheckOpencodeProviderCredentialsInput,
): Promise<OpencodeProviderCredentialCheck> {
  const providers = await listOpencodeAuthProviders({
    launcherPath: input.launcherPath,
    homeDir: input.homeDir,
    env: input.env,
    loadCredentials: input.loadCredentials,
  });

  if (providers.length === 0) {
    return { ok: false, remediation: buildRemediation(input.launcherPath) };
  }
  return { ok: true, providers };
}

/**
 * Build the "how to fix it" message. Quotes the launcher path so paths with
 * spaces stay copy-pasteable. Falls back to a bare `opencode auth login` when
 * no launcher path was provisioned yet.
 */
export function buildRemediation(launcherPath?: string): string {
  const command =
    launcherPath === undefined
      ? "opencode auth login"
      : `"${launcherPath}" auth login`;
  return [
    "No AI provider credentials were found.",
    "",
    "Sign in with the AI runtime Boboddy provisioned for you:",
    "",
    `  ${command}`,
    "",
    "Pick a provider (Anthropic is recommended) and follow the prompts, then",
    "re-run this command. Alternatively, export a provider API key such as",
    "ANTHROPIC_API_KEY before re-running.",
  ].join("\n");
}
