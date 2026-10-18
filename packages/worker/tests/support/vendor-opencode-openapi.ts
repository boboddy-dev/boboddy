/**
 * Re-vendors `fixtures/opencode-openapi-<version>.json`: the
 * `components.schemas` of a real `opencode serve`'s `/openapi.json`, which the
 * config overlay tests validate against (see `opencode-config-schema.ts`).
 *
 *   bun run tests/support/vendor-opencode-openapi.ts <opencode-binary-or-launch.sh>
 *   bun x prettier --write tests/support/fixtures/opencode-openapi-*.json
 *
 * The binary must report the pinned `OPENCODE_RUNTIME_VERSION`. It runs against
 * a throwaway HOME/XDG sandbox on a loopback port and is killed afterwards, so
 * no user config, credential or background service is read or touched.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { OPENCODE_RUNTIME_VERSION } from "../../src/runtime/runtime-service/domain/opencode-runtime-payload";
import {
  basicAuthHeader,
  generateServerPassword,
  probeReadiness,
  SERVER_PASSWORD_ENV,
} from "../../src/runtime/runtime-service/infra/opencode-server-contract";

const READY_TIMEOUT_MS = 60_000;
const READY_INTERVAL_MS = 250;

export function vendoredOpenapiFixturePath(version: string): string {
  return path.join(
    import.meta.dir,
    "fixtures",
    `opencode-openapi-${version}.json`,
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("could not allocate a loopback port"));
        }
      });
    });
  });
}

function sandboxEnv(home: string, password: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    [SERVER_PASSWORD_ENV]: password,
  };
}

async function waitForReady(baseUrl: string, password: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "no probe yet";
  while (Date.now() < deadline) {
    const result = await probeReadiness({
      baseUrl,
      password,
      expectedVersion: OPENCODE_RUNTIME_VERSION,
    });
    if (result.kind === "ready") {
      return;
    }
    if (result.kind === "wrong-version") {
      throw new Error(
        `binary serves OpenCode ${result.version}, expected ${OPENCODE_RUNTIME_VERSION}`,
      );
    }
    last = result.reason;
    await Bun.sleep(READY_INTERVAL_MS);
  }
  throw new Error(`opencode serve never became ready: ${last}`);
}

async function fetchSchemas(
  binary: string,
): Promise<{ openapi: unknown; schemas: unknown }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "opencode-openapi-"));
  const password = generateServerPassword();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const child = Bun.spawn(
    [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: home,
      env: sandboxEnv(home, password),
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    await waitForReady(baseUrl, password);
    const response = await fetch(`${baseUrl}/openapi.json`, {
      headers: { authorization: basicAuthHeader(password) },
    });
    if (!response.ok) {
      throw new Error(`GET /openapi.json → HTTP ${String(response.status)}`);
    }
    const document = (await response.json()) as {
      openapi?: unknown;
      components?: { schemas?: unknown };
    };
    if (!document.components?.schemas) {
      throw new Error("/openapi.json has no components.schemas");
    }
    return { openapi: document.openapi, schemas: document.components.schemas };
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(home, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const binary = process.argv[2];
  if (!binary) {
    throw new Error(
      "usage: bun run tests/support/vendor-opencode-openapi.ts <opencode-binary>",
    );
  }
  const { openapi, schemas } = await fetchSchemas(path.resolve(binary));
  const fixture = {
    opencodeVersion: OPENCODE_RUNTIME_VERSION,
    openapi,
    components: { schemas },
  };
  const target = vendoredOpenapiFixturePath(OPENCODE_RUNTIME_VERSION);
  await writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`wrote ${target}`);
}

if (import.meta.main) {
  await main();
}
