/**
 * End-to-end integration test for the devcontainer MCP host (Channel D).
 *
 * This exercises the FULL production path for exposing a user's project tools
 * to the AI agent:
 *
 *   1. Spin up a "devcontainer" (a plain Linux container) on a shared docker
 *      network with the production DNS alias `devcontainer`, with a workspace
 *      mounted that contains a real `.opencode/tools/` tool file.
 *   2. Use the REAL `LocalDevcontainerMcpHostManager.ensure()` to inject the
 *      cross-compiled `boboddy` binary and start `boboddy mcp-host` inside it —
 *      identical to what the runtime orchestrator does in step 6 of launch().
 *   3. Spin up an "agent" container on the same network (standing in for the AI
 *      container) and, from inside it, hit the remote MCP endpoint at
 *      `http://devcontainer:<port>/mcp` exactly as OpenCode's MCP client would.
 *   4. Assert that `tools/list` reports the user's project tools.
 *
 * The whole point: prove that tools authored under `.opencode/tools/` in the
 * user's repo are actually discovered, loaded (in-process, no `node`), and
 * served over MCP to the agent container.
 *
 * Requires Docker. The cross-compiled Linux CLI binary must exist in
 * `apps/cli/dist/` — build it with:
 *   bun run --filter @boboddy/cli build
 *
 * Run with:
 *   bun test tests/runtime/runtime-service/integration/devcontainer-mcp-host.integration.test.ts
 */

import { mkdir, mkdtemp, rm, rmdir, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GenericContainer, Network } from "testcontainers";
import type { StartedTestContainer, StartedNetwork } from "testcontainers";
import { LocalDevcontainerMcpHostManager } from "../../../../src/runtime/runtime-service/infra/local-devcontainer-mcp-host-manager";
import { createProjectRuntimeSessionExecutionTarget } from "../../../../src/runtime/runtime-service/domain/project-runtime-session-execution-target";

const execFileAsync = promisify(execFile);

/**
 * A plain image that has the basics the MCP host manager relies on inside the
 * devcontainer: `sh`, `curl`, `python3` (for free-port allocation), and `uname`.
 * The official node image satisfies all of these and mirrors a realistic
 * devcontainer base. We do NOT rely on `node` for the MCP host itself — the
 * injected boboddy binary carries its own embedded Bun runtime.
 */
const DEVCONTAINER_IMAGE = "node:20-bookworm-slim";

/**
 * The DNS alias the AI container uses to reach the devcontainer on the session
 * network (PROJECT_RUNTIME_SESSION_PROJECT_NETWORK_ALIAS in production).
 */
const DEVCONTAINER_ALIAS = "devcontainer";

const PLUGIN_SDK_PACKAGE = "@opencode-ai/plugin";

/**
 * A tool file authored exactly as a user would put it in their repo at
 * `.opencode/tools/`. It imports the OpenCode plugin SDK (the realistic case)
 * and exposes a default + a named export.
 */
const PROJECT_TOOL_SOURCE = `
import { tool } from "${PLUGIN_SDK_PACKAGE}";

export default tool({
  description: "Echo a message back to the caller",
  args: { message: tool.schema.string().describe("Message to echo") },
  async execute(args) {
    return "echo:" + args.message;
  },
});

export const shout = tool({
  description: "Echo a message back in uppercase",
  args: { message: tool.schema.string() },
  async execute(args) {
    return { output: ("echo:" + args.message).toUpperCase() };
  },
});
`;

async function dockerImageExistsLocally(ref: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", ref, "--format", "."]);
    return true;
  } catch {
    return false;
  }
}

type McpToolListEntry = { name: string; description?: string };

/**
 * Perform an HTTP GET/POST from INSIDE the agent container using `node` (the
 * agent image has node; it does NOT have curl). Mirrors how the AI container's
 * MCP client reaches the remote host at `http://devcontainer:<port>/...`.
 */
async function httpFromAgent(
  agentContainerId: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const script =
    `const opts = ${JSON.stringify(
      body === undefined
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" } },
    )};` +
    (body === undefined ? "" : `opts.body = ${JSON.stringify(JSON.stringify(body))};`) +
    `const r = await fetch(${JSON.stringify(url)}, opts);` +
    `const t = await r.text();` +
    `process.stdout.write(t);`;

  const { stdout } = await execFileAsync("docker", [
    "exec",
    agentContainerId,
    "node",
    "--input-type=module",
    "-e",
    script,
  ]);
  return JSON.parse(stdout) as unknown;
}

async function mcpRequestFromAgent(
  agentContainerId: string,
  url: string,
  body: unknown,
): Promise<unknown> {
  return httpFromAgent(agentContainerId, url, body);
}

describe("Devcontainer MCP host — project tools exposed to agent (e2e)", () => {
  let network: StartedNetwork;
  let devcontainer: StartedTestContainer;
  let agentContainer: StartedTestContainer;
  let workspacePath: string;
  let mcpHostPort: number;
  const manager = new LocalDevcontainerMcpHostManager();
  let executionTarget: ReturnType<typeof createProjectRuntimeSessionExecutionTarget>;
  let skip = false;

  beforeAll(async () => {
    // Guard: the cross-compiled Linux binary must exist. The manager resolves it
    // from apps/cli/dist relative to this package's source tree.
    const arch = os.arch() === "arm64" ? "arm64" : "x64";
    const binaryName = `boboddy-linux-${arch}`;
    const binaryPath = path.resolve(
      import.meta.dir,
      "../../../../../../apps/cli/dist",
      binaryName,
    );
    try {
      await access(binaryPath);
    } catch {
      throw new Error(
        `Missing CLI binary ${binaryName} at ${binaryPath}.\n` +
          `Build it first: bun run --filter @boboddy/cli build`,
      );
    }

    if (!(await dockerImageExistsLocally(DEVCONTAINER_IMAGE))) {
      // Allow the test to pull on first run; if there is no network this throws
      // and the suite is skipped rather than failing the build.
      try {
        await execFileAsync("docker", ["pull", DEVCONTAINER_IMAGE]);
      } catch {
        skip = true;
        return;
      }
    }

    // --- Build the workspace exactly like a user's cloned repo ---
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "boboddy-mcp-e2e-"));
    const toolsDir = path.join(workspacePath, ".opencode", "tools");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(path.join(toolsDir, "echo.ts"), PROJECT_TOOL_SOURCE, "utf8");

    // A package.json declaring the plugin SDK so the MCP host's
    // ensureOpencodeNodeModules() can install it via arborist (the realistic
    // path for a project whose tools import the SDK).
    await writeFile(
      path.join(workspacePath, ".opencode", "package.json"),
      JSON.stringify(
        {
          name: "user-opencode-deps",
          version: "0.0.0",
          private: true,
          dependencies: { [PLUGIN_SDK_PACKAGE]: "latest" },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    // --- Shared session network with the production alias ---
    network = await new Network().start();

    // The devcontainer: workspace mounted at /workspaces/<basename> (the
    // devcontainer-cli convention the manager resolves via docker inspect).
    const workspaceMountTarget = `/workspaces/${path.basename(workspacePath)}`;
    devcontainer = await new GenericContainer(DEVCONTAINER_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(DEVCONTAINER_ALIAS)
      .withBindMounts([
        { source: workspacePath, target: workspaceMountTarget, mode: "rw" },
      ])
      .withWorkingDir(workspaceMountTarget)
      // Keep it alive; a real devcontainer stays running.
      .withCommand(["sleep", "infinity"])
      .withStartupTimeout(60_000)
      .start();

    // The "agent" container stands in for the AI container: same network, can
    // resolve the `devcontainer` alias and has curl to hit the remote MCP.
    agentContainer = await new GenericContainer(DEVCONTAINER_IMAGE)
      .withNetwork(network)
      .withNetworkAliases("agent")
      .withCommand(["sleep", "infinity"])
      .withStartupTimeout(60_000)
      .start();

    executionTarget = createProjectRuntimeSessionExecutionTarget({
      environmentRole: "project",
      runnerAssignment: "local:devcontainer",
      environmentRef: "local:session",
      metadata: {
        localExecution: {
          containerId: devcontainer.getId(),
          workspacePath,
          devcontainerConfigPath: ".devcontainer/devcontainer.json",
        },
      },
    });

    // --- The real production action: inject + start the MCP host ---
    mcpHostPort = await manager.ensure(executionTarget, []);
  }, 300_000);

  afterAll(async () => {
    if (executionTarget) {
      await manager.stop(executionTarget).catch(() => {});
    }
    await agentContainer?.stop().catch(() => {});
    await devcontainer?.stop().catch(() => {});
    await network?.stop().catch(() => {});
    if (workspacePath) {
      // The workspace is mounted into containers that run as root, so files
      // written by the container are root-owned and cannot be removed by the
      // unprivileged CI runner. Use a throwaway Alpine container (running as
      // root) to wipe all contents from inside Docker, then rmdir the now-empty
      // host directory (which the runner owns and can remove).
      await new GenericContainer("alpine")
        .withBindMounts([{ source: workspacePath, target: "/cleanup", mode: "rw" }])
        .withCommand(["sh", "-c", "find /cleanup -mindepth 1 -delete"])
        .start()
        .then((c) => c.stop())
        .catch(() => {});
      await rmdir(workspacePath).catch(() => {});
    }
  });

  test("MCP host became healthy and returned a port", () => {
    if (skip) return;
    expect(mcpHostPort).toBeGreaterThan(0);
  });

  test("agent container can reach the remote MCP /health via the devcontainer alias", async () => {
    if (skip) return;
    const health = (await httpFromAgent(
      agentContainer.getId(),
      `http://${DEVCONTAINER_ALIAS}:${mcpHostPort}/health`,
    )) as { status: string; tools: number };
    expect(health.status).toBe("ok");
    expect(health.tools).toBeGreaterThan(0);
  });

  test("tools/list over MCP reports the project's tool files", async () => {
    if (skip) return;
    const url = `http://${DEVCONTAINER_ALIAS}:${mcpHostPort}/mcp`;

    // initialize handshake (MCP clients send this first)
    await mcpRequestFromAgent(agentContainer.getId(), url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    const listResponse = (await mcpRequestFromAgent(agentContainer.getId(), url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as { result?: { tools?: McpToolListEntry[] } };

    const toolNames = (listResponse.result?.tools ?? []).map((t) => t.name).sort();

    // Default export → "echo"; named export → "echo_shout".
    expect(toolNames).toContain("echo");
    expect(toolNames).toContain("echo_shout");
  });

  test("tools/call executes a project tool end-to-end through the agent", async () => {
    if (skip) return;
    const url = `http://${DEVCONTAINER_ALIAS}:${mcpHostPort}/mcp`;

    const callResponse = (await mcpRequestFromAgent(agentContainer.getId(), url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hi" } },
    })) as {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    };

    expect(callResponse.result?.isError).toBe(false);
    expect(callResponse.result?.content?.[0]?.text).toBe("echo:hi");
  });
});
