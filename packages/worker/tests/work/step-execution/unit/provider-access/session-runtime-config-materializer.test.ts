import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionRuntimeConfigMaterializer } from "../../../../../src/work/step-execution/infra/provider-access/session-runtime-config-materializer";
import type { ProviderAccess } from "../../../../../src/work/step-execution/contracts/agent-runtime/provider-access-resolver";
import type { EnvSource } from "../../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";

function envFrom(values: Record<string, string>): EnvSource {
  return (name) => values[name];
}

const RUNTIME_CONTAINER_ID = "devcontainer-abc";
const WORKSPACE_FOLDER = "/workspaces/project";

describe("SessionRuntimeConfigMaterializer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "materializer-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("emits base url and token env from the env source", async () => {
    const materializer = new SessionRuntimeConfigMaterializer({
      outputBaseDir: tmpDir,
      env: envFrom({ MY_TOKEN: "secret-value" }),
    });

    const providerAccess: ProviderAccess = {
      mode: "direct",
      baseUrl: "https://api.example.com",
      tokenEnv: "MY_TOKEN",
    };

    const result = await materializer.materialize({
      runtimeContainerId: RUNTIME_CONTAINER_ID,
      workspaceFolder: WORKSPACE_FOLDER,
      providerAccess,
    });

    expect(result.env["BOBODDY_PROVIDER_BASE_URL"]).toBe(
      "https://api.example.com",
    );
    expect(result.env["MY_TOKEN"]).toBe("secret-value");
    expect(result.configFiles).toBeUndefined();
  });

  test("omits token env key when the env value is absent", async () => {
    const materializer = new SessionRuntimeConfigMaterializer({
      outputBaseDir: tmpDir,
      env: envFrom({}),
    });

    const result = await materializer.materialize({
      runtimeContainerId: RUNTIME_CONTAINER_ID,
      workspaceFolder: WORKSPACE_FOLDER,
      providerAccess: { mode: "direct", tokenEnv: "MISSING_TOKEN" },
    });

    expect(result.env["MISSING_TOKEN"]).toBeUndefined();
    expect(Object.keys(result.env)).toHaveLength(0);
  });

  test("copies only the listed config files into a per-session dir", async () => {
    const sourceDir = path.join(tmpDir, "src");
    await mkdir(sourceDir, { recursive: true });
    const authPath = path.join(sourceDir, "auth.json");
    await writeFile(authPath, '{"anthropic":{"type":"api","key":"k"}}');

    const materializer = new SessionRuntimeConfigMaterializer({
      outputBaseDir: tmpDir,
      env: envFrom({}),
    });

    const result = await materializer.materialize({
      runtimeContainerId: RUNTIME_CONTAINER_ID,
      workspaceFolder: WORKSPACE_FOLDER,
      providerAccess: { mode: "direct", configFiles: [authPath] },
    });

    expect(result.configFiles).toHaveLength(1);
    const written = result.configFiles?.[0] ?? "";
    // Written under a session-scoped dir keyed by the runtime container id.
    expect(written).toContain(path.join(tmpDir, RUNTIME_CONTAINER_ID));
    expect(written).not.toBe(authPath);
    const copied = await readFile(written, "utf8");
    expect(copied).toBe('{"anthropic":{"type":"api","key":"k"}}');
  });

  test("returns original paths when copyConfigFiles is disabled", async () => {
    const sourceDir = path.join(tmpDir, "src");
    await mkdir(sourceDir, { recursive: true });
    const authPath = path.join(sourceDir, "auth.json");
    await writeFile(authPath, "{}");

    const materializer = new SessionRuntimeConfigMaterializer({
      outputBaseDir: tmpDir,
      env: envFrom({}),
      copyConfigFiles: false,
    });

    const result = await materializer.materialize({
      runtimeContainerId: RUNTIME_CONTAINER_ID,
      workspaceFolder: WORKSPACE_FOLDER,
      providerAccess: { mode: "direct", configFiles: [authPath] },
    });

    expect(result.configFiles).toEqual([authPath]);
  });

  test("throws for non-direct (brokered) provider access", async () => {
    const materializer = new SessionRuntimeConfigMaterializer({
      outputBaseDir: tmpDir,
      env: envFrom({}),
    });

    let caught: unknown;
    try {
      await materializer.materialize({
        runtimeContainerId: RUNTIME_CONTAINER_ID,
        workspaceFolder: WORKSPACE_FOLDER,
        providerAccess: { mode: "brokered" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/only 'direct' is supported/);
  });
});
