/**
 * `hostEnv` on {@link LaunchDevcontainerInput}: extra variables merged over
 * `process.env` for the spawned devcontainer CLI (the host-side environment
 * `initializeCommand` runs in). The CLI bundle is replaced by a stub script that
 * reports the env it was spawned with.
 *
 * These tests mutate `process.env`, so they run serially.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import type { LaunchDevcontainerInput } from "../../../../src/runtime/runtime-service/application/devcontainer-launcher";
import { DevcontainerCliLauncher } from "../../../../src/runtime/runtime-service/infra/devcontainer-cli-launcher";

const REPORTED_ENV_KEYS = ["BOBODDY_GIT_CACHE_DIR", "BOBODDY_HOST_ENV_OTHER"];

const STUB_SCRIPT = `
const keys = ${JSON.stringify(REPORTED_ENV_KEYS)};
const env = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
process.stdout.write(JSON.stringify({ containerId: "stub-container", env }));
`;

describe("devcontainer CLI launcher hostEnv", () => {
  let stubDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    stubDir = await mkdtemp(path.join(os.tmpdir(), "devcontainer-stub-"));
    const scriptPath = path.join(stubDir, "devcontainer-stub.js");
    await writeFile(scriptPath, STUB_SCRIPT, "utf8");
    for (const key of ["BOBODDY_DEVCONTAINER_SCRIPT", ...REPORTED_ENV_KEYS]) {
      saved[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
    process.env["BOBODDY_DEVCONTAINER_SCRIPT"] = scriptPath;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    await rm(stubDir, { recursive: true, force: true });
  });

  function launchInput(
    hostEnv?: Record<string, string>,
  ): LaunchDevcontainerInput {
    return {
      sessionId: createUuidV7(),
      projectId: createUuidV7(),
      requestedByUserId: createUuidV7(),
      workspacePath: stubDir,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      ...(hostEnv ? { hostEnv } : {}),
    };
  }

  async function spawnedEnv(
    input: LaunchDevcontainerInput,
  ): Promise<Record<string, string | null>> {
    const result = await new DevcontainerCliLauncher().launch(input);
    const output = result.metadata?.["launchOutput"];
    if (typeof output !== "string") {
      throw new Error("stub devcontainer CLI produced no launch output");
    }
    const parsed = JSON.parse(output) as {
      env: Record<string, string | null>;
    };
    return parsed.env;
  }

  test("merges hostEnv into the spawned CLI environment", async () => {
    const env = await spawnedEnv(
      launchInput({ BOBODDY_GIT_CACHE_DIR: "/var/cache/boboddy" }),
    );

    expect(env["BOBODDY_GIT_CACHE_DIR"]).toBe("/var/cache/boboddy");
  });

  test("hostEnv wins over the same key in process.env and keeps other process.env vars", async () => {
    process.env["BOBODDY_GIT_CACHE_DIR"] = "/from/process";
    process.env["BOBODDY_HOST_ENV_OTHER"] = "kept";

    const env = await spawnedEnv(
      launchInput({ BOBODDY_GIT_CACHE_DIR: "/from/host-env" }),
    );

    expect(env["BOBODDY_GIT_CACHE_DIR"]).toBe("/from/host-env");
    expect(env["BOBODDY_HOST_ENV_OTHER"]).toBe("kept");
  });

  test("without hostEnv the spawned environment is process.env unchanged", async () => {
    process.env["BOBODDY_GIT_CACHE_DIR"] = "/from/process";

    const env = await spawnedEnv(launchInput());

    expect(env["BOBODDY_GIT_CACHE_DIR"]).toBe("/from/process");
  });

  test("without hostEnv nothing is exported that process.env lacks", async () => {
    const env = await spawnedEnv(launchInput());

    expect(env["BOBODDY_GIT_CACHE_DIR"]).toBeNull();
  });
});
