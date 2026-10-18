import type { SecretMasker } from "../../../work/task/application/secret-masker";
import { checkOpencodeConfigDiagnostics } from "./opencode-config-diagnostics";
import { injectOpencodeCredentials } from "./opencode-credential-injection";
import type { OpencodeCredential } from "./opencode-credential-source";

/**
 * The boot steps both bootstraps run once `/api/info` reports ready: surface
 * config diagnostics (failing the launch if Boboddy's own overlay was
 * rejected), then inject the user's provider credentials.
 */
export async function completeOpencodeBoot(input: {
  baseUrl: string;
  password: string;
  workspaceFolder: string;
  readLog: () => Promise<string | null>;
  masker: SecretMasker;
  credentials: readonly OpencodeCredential[];
  logContext: Record<string, unknown>;
}): Promise<void> {
  await checkOpencodeConfigDiagnostics({
    baseUrl: input.baseUrl,
    password: input.password,
    workspaceFolder: input.workspaceFolder,
    readLog: input.readLog,
    masker: input.masker,
    logContext: input.logContext,
  });
  if (input.credentials.length > 0) {
    await injectOpencodeCredentials({
      baseUrl: input.baseUrl,
      password: input.password,
      credentials: input.credentials,
      logContext: input.logContext,
    });
  }
}
