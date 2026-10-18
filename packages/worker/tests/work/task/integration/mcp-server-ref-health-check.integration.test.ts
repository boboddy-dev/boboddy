/**
 * Integration test for MCP server refs, end to end: a step declares
 * `{ type: "ref" }` and the server is defined only in the project's
 * `.opencode/opencode.json` (v1 shape, as real user configs still are). The
 * worker resolves the ref, OpenCode starts the real fixture MCP server, and a
 * forced health check call through the ref'd key passes.
 *
 * Uses the `no_workspace` orchestrator (a real host `opencode serve`, no
 * Docker). Its temp working dir is `<tmpdir>/boboddy-noworkspace/<sessionId>`,
 * so the test seeds the project config there before launch; in real use that
 * dir is empty and a ref cannot resolve. OpenCode also loads that same
 * project config natively, so this covers the overlay and the user config
 * both defining the server.
 *
 * Gated behind BOBODDY_INTEGRATION=true, like
 * `force-and-verify-mcp-health-check.integration.test.ts`.
 *
 * Run with:
 *   BOBODDY_INTEGRATION=true bun test tests/work/task/integration/mcp-server-ref-health-check.integration.test.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forceAndVerifyMcpHealthCheck } from "../../../../src/work/task/application/force-and-verify-mcp-health-check";
import { pollMcpStatus } from "../../../../src/work/task/application/poll-mcp-status";
import { planStepEnv } from "../../../../src/work/task/application/resolve-step-env";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import {
  createUuidV7,
  type UuidV7,
} from "../../../../src/common/contracts/uuid-v7";
import { FakeAiServer } from "../../../../src/work/task/infra/fake-ai/fake-ai-server";
import { DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator } from "../../../../src/work/task/infra/local-noworkspace-runtime-environment";
import { OpencodeRuntimePayloadProvisioner } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { HostOpencodeBootstrap } from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { SessionRuntimeConfigMaterializer } from "../../../../src/work/task/infra/provider-access/session-runtime-config-materializer";
import { SafeProviderAccessResolver } from "../../../../src/work/task/infra/provider-access/safe-provider-access-resolver";
import { DirectProviderAccessResolver } from "../../../../src/work/task/infra/provider-access/direct-provider-access-resolver";
import { noopLogger, createLogger } from "@boboddy/observability/logging/host";
import type { TaskRuntimeEnvironment } from "../../../../src/work/task/contracts/process-project-work-types";

const integrationEnabled = process.env["BOBODDY_INTEGRATION"] === "true";
const TEST_TIMEOUT_MS = 3 * 60 * 1000;

const FIXTURE_SERVER_PATH = path.join(
  import.meta.dirname,
  "helpers",
  "mcp",
  "fixture-mcp-server.ts",
);

function buildOrchestrator() {
  const logger = createLogger({
    name: "@boboddy/worker",
    level:
      process.env["BOBODDY_INTEGRATION_VERBOSE"] === "true"
        ? "debug"
        : "silent",
  });
  return new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(logger, {
    payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
    providerAccessResolver: new SafeProviderAccessResolver(
      new DirectProviderAccessResolver({ logger: noopLogger }),
    ),
    runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
      outputBaseDir: path.join(process.cwd(), ".boboddy-tmp-provider-config"),
    }),
    hostOpencodeBootstrap: new HostOpencodeBootstrap(),
    loadCredentials: () => Promise.resolve([]),
  });
}

async function seedProjectMcpConfig(
  sessionId: string,
  mcp: Record<string, unknown>,
): Promise<void> {
  const projectConfigDir = path.join(
    os.tmpdir(),
    "boboddy-noworkspace",
    sessionId,
    ".opencode",
  );
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(
    path.join(projectConfigDir, "opencode.json"),
    JSON.stringify({ mcp }),
  );
}

describe.skipIf(!integrationEnabled)(
  "MCP server ref health check (integration)",
  () => {
    let fakeAiServer: FakeAiServer;
    let environment: TaskRuntimeEnvironment | undefined;

    beforeEach(() => {
      fakeAiServer = new FakeAiServer({
        verbose: process.env["BOBODDY_INTEGRATION_VERBOSE"] === "true",
      });
    });

    afterEach(async () => {
      await environment?.cleanup().catch(() => undefined);
      environment = undefined;
      await fakeAiServer.stop().catch(() => undefined);
    });

    async function launch(
      sessionId: UuidV7,
      opencodeMcpJson: OpenCodeMcpServers,
    ) {
      await fakeAiServer.start();
      const { resolved, resolveMcpEnv } = planStepEnv({
        envJson: null,
        inputJson: {},
        workerEnv: process.env,
        opencodeMcpJson,
      });
      environment = await buildOrchestrator().launch({
        startAgent: true,
        sessionId,
        projectId: createUuidV7(),
        requestedByUserId: createUuidV7(),
        gitUrl: "unused-for-no_workspace",
        repo: { mode: "none" },
        opencodeMcpJson,
        stepEnv: resolved.stepEnv,
        resolveMcpEnv,
        currentExecutionInfo: {
          taskId: sessionId,
          resultSchemaJson: null,
        },
        fakeAiProviderOverride: {
          baseUrl: `http://127.0.0.1:${String(fakeAiServer.port)}`,
        },
      });
      const { agent } = environment;
      if (!agent) {
        throw new Error("Expected the launch to start an agent");
      }
      return {
        environment,
        server: {
          baseUrl: agent.baseUrl,
          password: agent.password,
          workspaceFolder: environment.workspaceFolder,
        },
      };
    }

    test(
      "a ref resolved from the project config starts and answers a forced tool call",
      async () => {
        const sessionId = createUuidV7();
        await seedProjectMcpConfig(sessionId, {
          "fixture-source": {
            type: "local",
            command: ["bun", "run", FIXTURE_SERVER_PATH],
            enabled: true,
          },
        });

        const { server } = await launch(sessionId, {
          fixture: { type: "ref", name: "fixture-source" },
        });

        const statuses = await pollMcpStatus(server, {
          expectedServers: ["fixture"],
        });
        expect(
          statuses.find((status) => status.name === "fixture")?.healthy,
        ).toBe(true);

        const result = await forceAndVerifyMcpHealthCheck({
          server,
          healthCheck: { tool: "fixture_echo", args: { text: "ping" } },
          fakeAiServer,
          timeoutMs: 30_000,
        });
        expect(result).toEqual({ passed: true });
      },
      TEST_TIMEOUT_MS,
    );
  },
);
