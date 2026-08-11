import { listOpencodeAuthProviders } from "../../../work/step-execution/infra/provider-access/opencode-credential-discovery";

/**
 * Pre-flight check for the interactive OpenCode TUI: does the user have any AI
 * provider credential the TUI can actually use?
 *
 * Two sources are considered, mirroring what OpenCode itself accepts:
 *
 *   1. `~/.local/share/opencode/auth.json` — written by `opencode auth login`.
 *   2. Well-known provider API-key env vars already present in the environment.
 *
 * PRIVACY: only provider NAMES are read, returned, or logged. Token values,
 * key material, and env var VALUES never leave this module — the env check only
 * tests for a non-empty string.
 */

/**
 * Well-known provider API-key env vars OpenCode picks up without an
 * `auth.json` entry, mapped to the provider name we report.
 */
const PROVIDER_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["GEMINI_API_KEY", "google"],
  ["GOOGLE_GENERATIVE_AI_API_KEY", "google"],
  ["OPENROUTER_API_KEY", "openrouter"],
  ["GROQ_API_KEY", "groq"],
  ["XAI_API_KEY", "xai"],
  ["DEEPSEEK_API_KEY", "deepseek"],
];

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
   * Absolute path of the provisioned OpenCode launcher (`launch.sh`). Used to
   * build the remediation command — the user may not have `opencode` on PATH at
   * all, so we always point at the binary Boboddy provisioned.
   *
   * Optional: a caller that only needs the yes/no answer (not the remediation
   * text) can omit it rather than provision the runtime just to ask the
   * question — `boboddy init` does exactly that before deciding whether to run
   * `opencode auth login` inline.
   */
  launcherPath?: string | undefined;
  /** Host home dir override (tests). Defaults to `HOME`/`os.homedir()`. */
  homeDir?: string | undefined;
  /** Env source override (tests). Defaults to `process.env`. */
  env?: ((name: string) => string | undefined) | undefined;
};

/**
 * Resolve whether any usable provider credential exists, or the remediation the
 * user should follow.
 */
export async function checkOpencodeProviderCredentials(
  input: CheckOpencodeProviderCredentialsInput,
): Promise<OpencodeProviderCredentialCheck> {
  const env = input.env ?? ((name: string) => process.env[name]);

  const providers = new Set(
    await listOpencodeAuthProviders({ homeDir: input.homeDir }),
  );
  for (const [envVar, providerName] of PROVIDER_ENV_VARS) {
    if ((env(envVar) ?? "").trim().length > 0) {
      providers.add(providerName);
    }
  }

  if (providers.size === 0) {
    return { ok: false, remediation: buildRemediation(input.launcherPath) };
  }

  return {
    ok: true,
    providers: [...providers].sort((left, right) => left.localeCompare(right)),
  };
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
