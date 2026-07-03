import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MaterializeRuntimeConfigInput,
  MaterializeRuntimeConfigResult,
  RuntimeConfigMaterializer,
} from "../../contracts/agent-runtime/runtime-config-materializer";
import type { EnvSource } from "./direct-provider-access-resolver";

/**
 * Session-scoped {@link RuntimeConfigMaterializer}.
 *
 * Given a normalized {@link MaterializeRuntimeConfigInput} (runtime container
 * id, resolved workspace folder, and resolved `ProviderAccess`), produces what
 * OpenCode needs PER SESSION as a deterministic `{ env, configFiles }` result:
 *
 *   - `env`: the provider token placed under its `tokenEnv` name, plus the
 *     provider base URL when present. The actual injection into the container
 *     happens in Phase 3; Phase 2 only computes the values.
 *   - `configFiles`: absolute paths of config files copied into a
 *     session-scoped directory (never the host credential dirs directly).
 *
 * Credential isolation (per the migration plan):
 *   - Reads ONLY the specific `providerAccess.configFiles` the resolver chose,
 *     never a broad sweep of the host home.
 *   - The provider token value is sourced from the worker env under the
 *     resolved `tokenEnv` name (an injectable {@link EnvSource}), so the
 *     resolver never has to embed the secret in the contract.
 *   - Materialized output is written under a per-session directory so sessions
 *     do not share credential material.
 */

const SESSION_CONFIG_SUBDIR = "provider";

export type SessionRuntimeConfigMaterializerOptions = {
  /**
   * Base directory under which per-session materialized config is written.
   * A subdirectory keyed by the runtime container id is created beneath it.
   */
  outputBaseDir: string;
  /**
   * Env source used to read the token value for the resolved `tokenEnv`.
   * Defaults to `process.env`. Host/worker-level only.
   */
  env?: EnvSource | undefined;
  /**
   * When true, copy the resolved `providerAccess.configFiles` into the
   * session output dir and return the copied paths. When false, the original
   * paths are returned as-is. Defaults to true so credentials are isolated to
   * the session dir rather than referencing host paths.
   */
  copyConfigFiles?: boolean | undefined;
};

const processEnvSource: EnvSource = (name) => process.env[name];

function sessionOutputDir(baseDir: string, runtimeContainerId: string): string {
  return path.join(baseDir, runtimeContainerId, SESSION_CONFIG_SUBDIR);
}

export class SessionRuntimeConfigMaterializer
  implements RuntimeConfigMaterializer
{
  private readonly outputBaseDir: string;
  private readonly env: EnvSource;
  private readonly copyConfigFiles: boolean;

  constructor(options: SessionRuntimeConfigMaterializerOptions) {
    this.outputBaseDir = options.outputBaseDir;
    this.env = options.env ?? processEnvSource;
    this.copyConfigFiles = options.copyConfigFiles ?? true;
  }

  async materialize(
    input: MaterializeRuntimeConfigInput,
  ): Promise<MaterializeRuntimeConfigResult> {
    const { providerAccess } = input;

    if (providerAccess.mode !== "direct") {
      throw new Error(
        `Cannot materialize provider access mode '${providerAccess.mode}': ` +
          "only 'direct' is supported.",
      );
    }

    const env: Record<string, string> = {};

    if (providerAccess.baseUrl) {
      env["BOBODDY_PROVIDER_BASE_URL"] = providerAccess.baseUrl;
    }

    if (providerAccess.tokenEnv) {
      const tokenValue = this.env(providerAccess.tokenEnv);
      if (tokenValue !== undefined && tokenValue.length > 0) {
        env[providerAccess.tokenEnv] = tokenValue;
      }
    }

    const configFiles = await this.materializeConfigFiles(
      input.runtimeContainerId,
      providerAccess.configFiles ?? [],
    );

    return configFiles.length > 0 ? { env, configFiles } : { env };
  }

  private async materializeConfigFiles(
    runtimeContainerId: string,
    sourcePaths: readonly string[],
  ): Promise<string[]> {
    if (sourcePaths.length === 0) {
      return [];
    }

    if (!this.copyConfigFiles) {
      return [...sourcePaths];
    }

    const destDir = sessionOutputDir(this.outputBaseDir, runtimeContainerId);
    await mkdir(destDir, { recursive: true });

    const written: string[] = [];
    for (const sourcePath of sourcePaths) {
      // Read ONLY the specific file the resolver chose. No directory scans.
      const contents = await readFile(sourcePath, "utf8");
      const destPath = path.join(destDir, path.basename(sourcePath));
      await writeFile(destPath, contents, { mode: 0o600 });
      written.push(destPath);
    }
    return written;
  }
}

export const __sessionRuntimeConfigMaterializerInternals = {
  SESSION_CONFIG_SUBDIR,
  sessionOutputDir,
};
