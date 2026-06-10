/**
 * Integration test: verifies that extraEnv vars passed to DockerAiContainerLauncher
 * are actually present inside the running AI container.
 *
 * Uses the real AI worker image but does not submit any prompts to an AI
 * provider — it only starts the container and inspects its environment via
 * `docker exec`.
 *
 * The image is resolved via resolveAiImage() — set PROJECT_RUNTIME_SESSION_AI_IMAGE
 * to override, same as in production.
 *
 * Run with:
 *   bun test tests/runtime/runtime-service/integration
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GenericContainer, Wait } from "testcontainers";
import {
  buildAiContainerBaseArgs,
  ensureBoboddyRuntimeWorkspaceRoot,
  getSessionHomePath,
  resolveAiImage,
  resolveWorkspaceOwnership,
} from "../../../../src/runtime/runtime-service/infra/docker-ai-container-launcher";

const execFileAsync = promisify(execFile);

const AI_IMAGE = resolveAiImage();

// Env vars we want to assert are forwarded into the container.
const TEST_ENV_VARS: Record<string, string> = {
  DATABASE_URI: "postgres://user:pass@db:5432/testdb",
  MY_CUSTOM_SECRET: "hunter2",
  ANOTHER_VAR: "hello-world",
};

describe("DockerAiContainerLauncher — env var binding (integration)", () => {
  let workspacePath: string;
  let container: Awaited<ReturnType<GenericContainer["start"]>>;

  beforeAll(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "boboddy-test-env-"));

    // The AI container entrypoint runs:
    //   ln -sfn /opt/boboddy/opencode-runtime/node_modules /workspace/.opencode/node_modules
    // so the .opencode directory must exist before the container starts.
    await ensureBoboddyRuntimeWorkspaceRoot(workspacePath);
    await mkdir(path.join(workspacePath, ".opencode"), { recursive: true });

    const sessionHomePath = getSessionHomePath(workspacePath);

    // Pre-create the home dirs the entrypoint and opencode server expect.
    await mkdir(path.join(sessionHomePath, ".local", "share", "opencode"), {
      recursive: true,
    });
    await mkdir(path.join(sessionHomePath, ".local", "state"), {
      recursive: true,
    });

    const workspaceOwnership = await resolveWorkspaceOwnership(workspacePath);

    // Build the exact same base args the real launcher uses.
    const baseArgs = buildAiContainerBaseArgs({
      workspacePath,
      sessionHomePath,
      workspaceOwnership,
      projectId: "test-project-id",
      sessionId: "test-session-id",
      requestedByUserId: "test-user-id",
      extraEnv: TEST_ENV_VARS,
      // No host opencode config/data — keeps the test hermetic.
      hasHostOpencodeConfig: false,
      hostOpencodeConfigPath: "",
      hasHostOpencodeData: false,
      hostOpencodeDataPath: "",
      image: AI_IMAGE.ref,
    });

    // buildAiContainerBaseArgs appends the image as the final element;
    // strip it because GenericContainer takes the image separately.
    const createArgs = baseArgs.slice(0, -1);

    // Translate the flat docker-cli arg list into the testcontainers builder API.
    //
    // We intentionally do NOT use withExposedPorts here: testcontainers waits
    // for Docker to report host port bindings, and the AI container takes
    // ~12 s to start listening — longer than that internal timeout.
    // Instead we use Wait.forLogMessage to detect readiness, and then
    // assert env vars via `docker exec` (no HTTP needed).
    const tcContainer = new GenericContainer(AI_IMAGE.ref)
      .withStartupTimeout(90_000)
      .withWaitStrategy(
        // The opencode server logs this line once it's ready to accept requests.
        Wait.forLogMessage("opencode server listening on"),
      );
    // Collect bind mounts separately — withBindMounts() replaces the full
    // list on each call, so we must pass all mounts in a single invocation.
    const bindMounts: Array<{
      source: string;
      target: string;
      readOnly: boolean;
    }> = [];
    const envVars: Record<string, string> = {};

    for (let i = 0; i < createArgs.length; i++) {
      const flag = createArgs[i];
      const value = createArgs[i + 1];

      if (flag === "--user" && value) {
        tcContainer.withUser(value);
        i++;
      } else if (flag === "-w" && value) {
        tcContainer.withWorkingDir(value);
        i++;
      } else if (flag === "-e" && value) {
        const eqIdx = value.indexOf("=");
        if (eqIdx !== -1) {
          envVars[value.slice(0, eqIdx)] = value.slice(eqIdx + 1);
        }
        i++;
      } else if (flag === "-v" && value) {
        const colonIdx = value.indexOf(":");
        if (colonIdx !== -1) {
          const source = value.slice(0, colonIdx);
          const rest = value.slice(colonIdx + 1);
          // Strip optional :ro suffix from the target path
          const roIdx = rest.lastIndexOf(":");
          const target = roIdx !== -1 ? rest.slice(0, roIdx) : rest;
          const readOnly = roIdx !== -1 && rest.slice(roIdx + 1) === "ro";
          bindMounts.push({ source, target, readOnly });
        }
        i++;
      }
      // --label and --add-host are intentionally skipped:
      //   labels don't affect runtime behaviour
      //   add-host is handled automatically by Docker Desktop on macOS
    }

    if (Object.keys(envVars).length > 0) {
      tcContainer.withEnvironment(envVars);
    }
    if (bindMounts.length > 0) {
      tcContainer.withBindMounts(bindMounts);
    }

    // Verify the image is available locally before attempting to start —
    // testcontainers will try to pull it if it's missing and hang for a long
    // time before timing out with an unhelpful error message.
    try {
      await execFileAsync("docker", [
        "image",
        "inspect",
        AI_IMAGE.ref,
        "--format",
        ".",
      ]);
    } catch {
      throw new Error(
        `AI worker image not found locally: ${AI_IMAGE.ref}\n` +
          `Pull it first with: docker pull ${AI_IMAGE.ref}`,
      );
    }

    container = await tcContainer.start();
  });

  afterAll(async () => {
    await container?.stop();
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  for (const [key, expectedValue] of Object.entries(TEST_ENV_VARS)) {
    test(`env var ${key} is present inside the container with correct value`, async () => {
      const containerId = container.getId();
      const { stdout } = await execFileAsync("docker", [
        "exec",
        containerId,
        "sh",
        "-c",
        `printf '%s' "$${key}"`,
      ]);
      expect(stdout).toBe(expectedValue);
    });
  }

  test("env vars not in extraEnv are not leaked into the container", async () => {
    // A sentinel that should never be set — guards against accidental injection.
    const sentinelKey = "BOBODDY_TEST_SENTINEL_SHOULD_NOT_EXIST";
    const containerId = container.getId();
    const { stdout } = await execFileAsync("docker", [
      "exec",
      containerId,
      "sh",
      "-c",
      `printf '%s' "\${${sentinelKey}:-__UNSET__}"`,
    ]);
    expect(stdout).toBe("__UNSET__");
  });
});
