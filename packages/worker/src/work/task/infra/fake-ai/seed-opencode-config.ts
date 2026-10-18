/**
 * Seeds an OpenCode global config that points the built-in `anthropic`
 * provider at a {@link FakeAiServer}, and names the env that supplies its fake
 * credential. This is the SINGLE source of truth shared by the worker
 * integration tests and the CLI-to-server e2e tests.
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
   * Additional directories to write an identical `opencode.json` into (e.g.
   * the Windows roaming `APPDATA/opencode` dir the CLI honors). The primary
   * `<homeDir>/.config/opencode/opencode.json` is always written.
   */
  extraConfigDirs?: readonly string[];
};

/**
 * Env the worker process must run with for the fake provider to have a
 * credential. The worker's credential source reads the well-known provider
 * API-key vars, so this both satisfies provider-access resolution and is
 * injected into the session's server over `POST /api/credential`. OpenCode 2.x
 * keeps credentials in its database, so there is no file to seed instead.
 */
export const FAKE_AI_PROVIDER_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "fake-key",
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
 * at the fake AI server. The caller must also run the worker with
 * {@link FAKE_AI_PROVIDER_ENV}, which is returned for convenience.
 *
 * @param homeDir      The home dir OpenCode reads config from (the test seeds
 *                     `HOME`/`XDG_*` to point here).
 * @param fakeAiPort   The port the {@link FakeAiServer} is listening on.
 */
export async function seedOpencodeConfig(
  homeDir: string,
  fakeAiPort: number,
  options: SeedOpencodeConfigOptions = {},
): Promise<Readonly<Record<string, string>>> {
  const fakeAiHost = options.fakeAiHost ?? resolveFakeAiHost();

  // Do NOT "unify" the `anthropic` provider id below with the synthetic
  // `FAKE_PROVIDER_ID` in `fake-provider-config.ts`. The two are deliberately
  // different. Here `anthropic` is load-bearing: the credential comes from
  // `ANTHROPIC_API_KEY` ({@link FAKE_AI_PROVIDER_ENV}), which the worker's
  // credential source only maps to the `anthropic` integration — a synthetic
  // id would resolve to no provider access at all. This seeder also only ever
  // runs against a fully isolated test `HOME` with no user OpenCode config, so
  // it cannot hit the credential/plugin collision that forced the health
  // check's provider id to become synthetic.
  //
  // OpenCode's standalone binary already bundles the `@ai-sdk/anthropic`
  // provider SDK, so nothing is installed at runtime. What it DOES need is a
  // resolvable model id: OpenCode looks the model up in the models.dev
  // registry (fetched at runtime), and `claude-3-5-haiku-latest` is not always
  // present there — an unknown id fails and the prompt never runs (so the
  // worker's "agent session never started" timeout fires). Declaring the model
  // inline under `providers.anthropic.models` makes it resolvable without
  // depending on the live registry, while `settings.baseURL` points the
  // bundled provider at the fake AI server. v2 reads `opencode.json` only; a
  // `config.json` is ignored.
  const model = "claude-3-5-haiku-latest";
  const config = {
    model: `anthropic/${model}`,
    providers: {
      anthropic: {
        package: "aisdk:@ai-sdk/anthropic",
        settings: {
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
    await writeFile(
      path.join(configDir, "opencode.json"),
      configContent,
      "utf8",
    );
  }

  return FAKE_AI_PROVIDER_ENV;
}
