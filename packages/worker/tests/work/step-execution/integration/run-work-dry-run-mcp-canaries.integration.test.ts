/**
 * Integration test for #110: wiring the MCP canary registry (#108) and
 * `forceAndVerifyMcpCanary` (#109) into the dry run's per-server report via
 * `runMcpCanaries`, end to end against REAL MCP servers.
 *
 * Exercises the same real pieces `force-and-verify-mcp-canary.integration.test.ts`
 * does — a real `opencode serve` process (via the `no_workspace` orchestrator),
 * a real `FakeAiServer`, and the real stdio fixture MCP server
 * (`helpers/mcp/fixture-mcp-server.ts`) — but drives them through
 * `pollMcpStatus` + `runMcpCanaries` + `computeDryRunOk`, i.e. the actual
 * wiring `run-work-dry-run.ts` performs, rather than calling
 * `forceAndVerifyMcpCanary` directly.
 *
 * Proves the acceptance criteria that are specific to #110 (as opposed to
 * #108/#109, which already cover the registry/matcher and the single forced
 * call in isolation):
 *   - A `connected`, `local` server with a registry match gets its canary run
 *     and the outcome lands in the per-server report.
 *   - A failed canary flips the overall `ok` the same way a failed handshake
 *     does today — even though BOTH servers' handshakes succeed here, so the
 *     flip can only be coming from the canary.
 *   - A single shared `FakeAiServer` instance is reused across both servers.
 *
 * Gated behind BOBODDY_INTEGRATION=true — see
 * `force-and-verify-mcp-canary.integration.test.ts` for why.
 *
 * Run with:
 *   BOBODDY_INTEGRATION=true bun test tests/work/step-execution/integration/run-work-dry-run-mcp-canaries.integration.test.ts
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pollMcpStatus } from "../../../../src/work/step-execution/application/run-work-dry-run-health-checks";
import {
  computeDryRunOk,
  runMcpCanaries,
} from "../../../../src/work/step-execution/application/run-work-dry-run-mcp-canaries";
import type { McpCanaryRegistryEntry } from "../../../../src/work/step-execution/application/mcp-canary-registry";
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

/**
 * A test-only registry: neither `fixture-working` nor `fixture-broken` would
 * ever match the production registry (playwright/postgres), so this is what
 * makes them canary-worthy in the first place — proving the "matched, ran,
 * and the result flows into the report" path, not just the "unverified"
 * fallback #108 already covers on its own.
 */
const fixtureRegistry: McpCanaryRegistryEntry[] = [
  {
    id: "fixture_working",
    matcher: { field: "name", pattern: /^fixture_working$/ },
    canary: { tool: "echo", args: { text: "ping" } },
  },
  {
    id: "fixture_broken",
    matcher: { field: "name", pattern: /^fixture_broken$/ },
    canary: { tool: "boom", args: {} },
  },
];

describe.skipIf(!integrationEnabled)(
  "runMcpCanaries + computeDryRunOk (integration)",
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
      "runs a canary per connected local server and flips `ok` on a genuine canary failure, not a handshake failure",
      async () => {
        const logger = createLogger({
          name: "@boboddy/worker",
          level:
            process.env["BOBODDY_INTEGRATION_VERBOSE"] === "true" ? "debug" : "silent",
        });

        const orchestrator = new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(
          logger,
          {
            payloadProvisioner: new OpencodeRuntimePayloadProvisioner(),
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
          },
        );

        await fakeAiServer.start();

        const sessionId = createUuidV7();
        environment = await orchestrator.launch({
          sessionId,
          projectId: createUuidV7(),
          requestedByUserId: createUuidV7(),
          gitUrl: "unused-for-no_workspace",
          opencodeMcpJson: {
            // Both handshakes succeed — proving any `ok: false` below comes
            // from the canary, not from `pollMcpStatus`.
            fixture_working: {
              type: "local",
              command: ["bun", "run", FIXTURE_SERVER_PATH],
              enabled: true,
            },
            fixture_broken: {
              type: "local",
              command: ["bun", "run", FIXTURE_SERVER_PATH],
              enabled: true,
            },
          },
          currentExecutionInfo: { stepExecutionId: sessionId, resultSchemaJson: null },
          fakeAiProviderOverride: {
            baseUrl: `http://127.0.0.1:${String(fakeAiServer.port)}`,
          },
        });

        const handshakeReports = await pollMcpStatus(
          environment.agentBaseUrl,
          environment.workspaceFolder,
        );
        expect(handshakeReports).toHaveLength(2);
        // Both servers actually connected — any `ok: false` below must come
        // from the canary step, not the handshake.
        for (const report of handshakeReports) {
          expect(report.status).toBe("connected");
          expect(report.healthy).toBe(true);
        }

        const mcpServers = await runMcpCanaries({
          agentBaseUrl: environment.agentBaseUrl,
          workspaceFolder: environment.workspaceFolder,
          mcpServers: handshakeReports,
          fakeAiServer,
          registry: fixtureRegistry,
        });

        const working = mcpServers.find((server) => server.name === "fixture_working");
        const broken = mcpServers.find((server) => server.name === "fixture_broken");

        expect(working?.canary).toEqual({ kind: "ran-and-passed" });
        expect(broken?.canary.kind).toBe("ran-and-failed");
        if (broken?.canary.kind === "ran-and-failed") {
          expect(broken.canary.reason).toBe("tool-error");
          expect(broken.canary.detail).toContain(
            "boom: intentionally broken fixture tool",
          );
        }

        // The single shared fake-LLM server instance was reused across both
        // canaried servers, not one instance started per server.
        expect(fakeAiServer.requestCount).toBeGreaterThanOrEqual(2);

        // A genuinely failed canary flips `ok`, at the same severity tier as
        // a failed handshake — even though both handshakes above succeeded.
        const ok = computeDryRunOk({
          containerHealthy: undefined,
          opencodeHealthy: true,
          mcpServers,
        });
        expect(ok).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
