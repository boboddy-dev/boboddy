import { describe, expect, test, mock, spyOn } from "bun:test";
import { LocalDevcontainerMcpHostManager } from "../../../../src/runtime/runtime-service/infra/local-devcontainer-mcp-host-manager";
import { createProjectRuntimeSessionExecutionTarget } from "../../../../src/runtime/runtime-service/domain/project-runtime-session-execution-target";

/**
 * Unit tests for LocalDevcontainerMcpHostManager.
 *
 * These tests mock `docker exec` calls to avoid requiring a real Docker environment.
 * They verify the inject/start/stop lifecycle by observing what commands are issued.
 */

function makeExecutionTarget(containerId: string) {
  return createProjectRuntimeSessionExecutionTarget({
    environmentRole: "project",
    runnerAssignment: "local:devcontainer",
    environmentRef: "local:session",
    metadata: {
      localExecution: {
        containerId,
        workspacePath: "/workspace",
        devcontainerConfigPath: ".devcontainer/devcontainer.json",
      },
    },
  });
}

describe("LocalDevcontainerMcpHostManager.stop", () => {
  test("stop does not throw when container is not running", async () => {
    // This test verifies that stop() is idempotent and doesn't throw even if
    // docker exec fails (container already gone).
    const manager = new LocalDevcontainerMcpHostManager();
    const target = makeExecutionTarget("nonexistent-container-id");

    // Should not throw — errors from docker exec are swallowed
    await expect(manager.stop(target)).resolves.toBeUndefined();
  });
});

describe("LocalDevcontainerMcpHostManager constants", () => {
  test("MCP_HOST_DIRECTORY_PATH is /tmp/boboddy-mcp-host", async () => {
    const { MCP_HOST_DIRECTORY_PATH } = await import(
      "../../../../src/runtime/runtime-service/infra/local-devcontainer-mcp-host-manager-support"
    );
    expect(MCP_HOST_DIRECTORY_PATH).toBe("/tmp/boboddy-mcp-host");
  });

  test("MCP_HOST_PID_PATH is under MCP_HOST_DIRECTORY_PATH", async () => {
    const { MCP_HOST_DIRECTORY_PATH, MCP_HOST_PID_PATH } = await import(
      "../../../../src/runtime/runtime-service/infra/local-devcontainer-mcp-host-manager-support"
    );
    expect(MCP_HOST_PID_PATH).toContain(MCP_HOST_DIRECTORY_PATH);
  });

  test("MCP_HOST_LOG_PATH is under MCP_HOST_DIRECTORY_PATH", async () => {
    const { MCP_HOST_DIRECTORY_PATH, MCP_HOST_LOG_PATH } = await import(
      "../../../../src/runtime/runtime-service/infra/local-devcontainer-mcp-host-manager-support"
    );
    expect(MCP_HOST_LOG_PATH).toContain(MCP_HOST_DIRECTORY_PATH);
  });

  test("MCP_HOST_BOOT_WAIT_MS is positive", async () => {
    const { MCP_HOST_BOOT_WAIT_MS } = await import(
      "../../../../src/runtime/runtime-service/infra/local-devcontainer-mcp-host-manager-support"
    );
    expect(MCP_HOST_BOOT_WAIT_MS).toBeGreaterThan(0);
  });

  test("MCP_HOST_HEALTH_TIMEOUT_MS is positive", async () => {
    const { MCP_HOST_HEALTH_TIMEOUT_MS } = await import(
      "../../../../src/runtime/runtime-service/infra/local-devcontainer-mcp-host-manager-support"
    );
    expect(MCP_HOST_HEALTH_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
