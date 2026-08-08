/**
 * Integration test for `forceAndVerifyMcpHealthCheck`.
 *
 * Exercises the real thing end to end: a real OpenCode `opencode serve`
 * process spawned directly on the host (via the same `no_workspace`
 * orchestrator the dry-run feature uses — no Docker needed for this path), a
 * real fake-LLM server (`FakeAiServer`, real HTTP, real Anthropic wire
 * format), and a REAL (not mocked) stdio MCP server
 * (`helpers/mcp/fixture-mcp-server.ts`, speaking the actual MCP protocol via
 * the official SDK). Only the AI provider is faked — the MCP server and the
 * OpenCode process are both real.
 *
 * Proves the working-vs-broken distinction the ticket's acceptance criteria
 * calls for:
 *   - `fixture_echo`  — a working tool call → `{ passed: true }`.
 *   - `fixture_boom`  — a genuinely broken tool call (throws) → `{ passed:
 *     false, reason: "tool-error", detail: <the real MCP error message> }`.
 *
 * Gated behind BOBODDY_INTEGRATION=true because it provisions the real
 * OpenCode runtime payload (downloaded from the npm registry) and spawns a
 * real host process, matching the convention used by
 * `work-command.integration.test.ts`.
 *
 * Run with:
 *   BOBODDY_INTEGRATION=true bun test tests/work/step-execution/integration/force-and-verify-mcp-health-check.integration.test.ts
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forceAndVerifyMcpHealthCheck } from "../../../../src/work/step-execution/application/force-and-verify-mcp-health-check";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { FakeAiServer } from "../../../../src/work/step-execution/infra/fake-ai/fake-ai-server";
import { DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator } from "../../../../src/work/step-execution/infra/local-noworkspace-runtime-environment";
import { OpencodeRuntimePayloadProvisioner } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import { HostOpencodeBootstrap } from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { SessionRuntimeConfigMaterializer } from "../../../../src/work/step-execution/infra/provider-access/session-runtime-config-materializer";
import { SafeProviderAccessResolver } from "../../../../src/work/step-execution/infra/provider-access/safe-provider-access-resolver";
import { DirectProviderAccessResolver } from "../../../../src/work/step-execution/infra/provider-access/direct-provider-access-resolver";
import { noopLogger, createLogger } from "../../../../src/lib/logger";
import type { StepExecutionRuntimeEnvironment } from "../../../../src/work/step-execution/contracts/process-project-work-types";

const integrationEnabled = process.env["BOBODDY_INTEGRATION"] === "true";
const TEST_TIMEOUT_MS = 3 * 60 * 1000;

const FIXTURE_SERVER_PATH = path.join(
  import.meta.dirname,
  "helpers",
  "mcp",
  "fixture-mcp-server.ts",
);

describe.skipIf(!integrationEnabled)(
  "forceAndVerifyMcpHealthCheck (integration)",
  () => {
    let fakeAiServer: FakeAiServer;
    let environment: StepExecutionRuntimeEnvironment | undefined;

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

    test(
      "distinguishes a working MCP tool call from a genuinely broken one",
      async () => {
        const logger = createLogger({
          name: "@boboddy/worker",
          level:
            process.env["BOBODDY_INTEGRATION_VERBOSE"] === "true"
              ? "debug"
              : "silent",
        });

        const orchestrator =
          new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(logger, {
            payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
            // No real AI provider credentials are needed — the health check
            // function under test runs against a synthetic fake provider pointed
            // at the fake-LLM server. A SafeProviderAccessResolver lets the host
            // process start even with none resolved.
            providerAccessResolver: new SafeProviderAccessResolver(
              new DirectProviderAccessResolver({ logger: noopLogger }),
            ),
            runtimeConfigMaterializer: new SessionRuntimeConfigMaterializer({
              outputBaseDir: path.join(
                process.cwd(),
                ".boboddy-tmp-provider-config",
              ),
            }),
            hostOpencodeBootstrap: new HostOpencodeBootstrap(),
          });

        // The agent runs directly on the host, alongside the fake-LLM server —
        // no docker.internal indirection needed. Start the fake-LLM server
        // first so its URL can be baked into the agent's launch-time config.
        await fakeAiServer.start();

        const sessionId = createUuidV7();
        environment = await orchestrator.launch({
          sessionId,
          projectId: createUuidV7(),
          requestedByUserId: createUuidV7(),
          gitUrl: "unused-for-no_workspace",
          opencodeMcpJson: {
            fixture: {
              type: "local",
              command: ["bun", "run", FIXTURE_SERVER_PATH],
              enabled: true,
            },
          },
          currentExecutionInfo: {
            stepExecutionId: sessionId,
            resultSchemaJson: null,
          },
          fakeAiProviderOverride: {
            baseUrl: `http://127.0.0.1:${String(fakeAiServer.port)}`,
          },
        });

        const working = await forceAndVerifyMcpHealthCheck({
          agentBaseUrl: environment.agentBaseUrl,
          workspaceFolder: environment.workspaceFolder,
          healthCheck: { tool: "fixture_echo", args: { text: "ping" } },
          fakeAiServer,
          timeoutMs: 30_000,
        });
        expect(working).toEqual({ passed: true });

        const broken = await forceAndVerifyMcpHealthCheck({
          agentBaseUrl: environment.agentBaseUrl,
          workspaceFolder: environment.workspaceFolder,
          healthCheck: { tool: "fixture_boom", args: {} },
          fakeAiServer,
          timeoutMs: 30_000,
        });
        expect(broken.passed).toBe(false);
        if (!broken.passed) {
          expect(broken.reason).toBe("tool-error");
          expect(broken.detail).toContain(
            "boom: intentionally broken fixture tool",
          );
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
