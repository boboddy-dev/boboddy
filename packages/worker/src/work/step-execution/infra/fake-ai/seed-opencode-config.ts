/**
 * Seeds an OpenCode global config + credential store that points the built-in
 * `anthropic` provider at a {@link FakeAiServer}. This is the SINGLE source of
 * truth shared by the worker integration tests and the CLI-to-server e2e tests.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type SeedOpencodeConfigOptions = {
  /**
   * Host the in-container OpenCode uses to reach the host-side fake AI server.
   * Defaults to {@link resolveFakeAiHost} (`BOBODDY_FAKE_AI_HOST` env or
   * `host.docker.internal`).
   */
  fakeAiHost?: string;
  /**
   * Additional directories to write an identical `config.json` into (e.g. the
   * Windows roaming `APPDATA/opencode` dir the CLI honors). The primary
   * `<homeDir>/.config/opencode/config.json` is always written.
   */
  extraConfigDirs?: readonly string[];
};

/**
 * The in-container OpenCode reaches the host-side fake AI server over this host.
 * macOS/Windows Docker Desktop resolve `host.docker.internal` natively; on Linux
 * it must be added via a host-gateway alias (the worker injects
 * `--add-host=host.docker.internal:host-gateway`) or overridden with
 * `BOBODDY_FAKE_AI_HOST`.
 */
export function resolveFakeAiHost(): string {
  const configured = process.env["BOBODDY_FAKE_AI_HOST"]?.trim();
  if (configured) {
    return configured;
  }
  return "host.docker.internal";
}

/**
 * Write an OpenCode global config that points the bundled `anthropic` provider
 * at the fake AI server, plus an api-key credential the worker-host
 * DirectProviderAccessResolver discovers.
 *
 * @param homeDir      The home dir OpenCode reads config/credentials from
 *                     (the test seeds `HOME`/`XDG_*` to point here).
 * @param fakeAiPort   The port the {@link FakeAiServer} is listening on.
 */
export async function seedOpencodeConfig(
  homeDir: string,
  fakeAiPort: number,
  options: SeedOpencodeConfigOptions = {},
): Promise<void> {
  const fakeAiHost = options.fakeAiHost ?? resolveFakeAiHost();

  // Do NOT "unify" the `anthropic` provider id below with the synthetic
  // `FAKE_PROVIDER_ID` in `fake-provider-config.ts`. The two are deliberately
  // different. Here `anthropic` is load-bearing: the `auth.json` written at
  // the bottom of this function is keyed by provider id, and the worker-host
  // DirectProviderAccessResolver only discovers a credential for a provider it
  // recognises — a synthetic id resolves to no provider access at all. This
  // seeder also only ever runs against a fully isolated test `HOME` with no
  // user OpenCode config, so it cannot hit the credential/plugin collision
  // that forced the health check's provider id to become synthetic.
  //
  // OpenCode's standalone binary already bundles the `@ai-sdk/anthropic`
  // provider SDK, so the built-in `anthropic` provider needs no `npm` install.
  // What it DOES need is a resolvable model id: OpenCode looks the model up in
  // the models.dev registry (fetched at runtime), and `claude-3-5-haiku-latest`
  // is not always present there — an unknown id fails with
  // ProviderModelNotFoundError and the prompt never runs (session stays idle,
  // so the worker's "agent session never started" timeout fires). Declaring the
  // model inline under `provider.anthropic.models` makes it resolvable without
  // depending on the live registry, while `options.baseURL` points the bundled
  // provider at the fake AI server.
  const model = "claude-3-5-haiku-latest";
  const config = {
    model: `anthropic/${model}`,
    provider: {
      anthropic: {
        options: {
          baseURL: `http://${fakeAiHost}:${String(fakeAiPort)}`,
          apiKey: "fake-key",
        },
        models: {
          [model]: {
            name: "Claude 3.5 Haiku (fake)",
          },
        },
      },
    },
  };
  const configContent = `${JSON.stringify(config, null, 2)}\n`;

  const configDirs = [
    path.join(homeDir, ".config", "opencode"),
    ...(options.extraConfigDirs ?? []),
  ];
  for (const configDir of configDirs) {
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "config.json"), configContent, "utf8");
  }

  // The worker-host DirectProviderAccessResolver discovers a local OpenCode
  // credential from ~/.local/share/opencode/auth.json (NOT the config above).
  // Seed an api-key entry so provider access resolves without requiring
  // BOBODDY_PROVIDER_* env overrides.
  const authDir = path.join(homeDir, ".local", "share", "opencode");
  await mkdir(authDir, { recursive: true });
  await writeFile(
    path.join(authDir, "auth.json"),
    `${JSON.stringify({ anthropic: { type: "api", key: "fake-key" } }, null, 2)}\n`,
    "utf8",
  );
}
