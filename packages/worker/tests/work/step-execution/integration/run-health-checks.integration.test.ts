/**
 * Integration test for the health check runner (#119).
 *
 * Exercises the same real pieces
 * `force-and-verify-mcp-health-check.integration.test.ts` does — a real
 * `opencode serve` process (via the `no_workspace` orchestrator), a real
 * `FakeAiServer`, and the real stdio fixture MCP server
 * (`helpers/mcp/fixture-mcp-server.ts`, exposing a working `echo` tool and a
 * deliberately throwing `boom` tool) — but drives them through
 * `runHealthChecks`, the actual function a step declaring `healthChecks`
 * calls, rather than the single-call invoker underneath it directly.
 *
 * Covers what only a real OpenCode process can prove:
 *   - A working MCP tool call passes; a throwing one fails with the tool's
 *     real error message.
 *   - `required` checks run in declaration order and the first failure
 *     aborts everything after it, including a later `warn` check.
 *   - A tool that was never registered (a real, non-MCP id — MCP tools never
 *     appear in OpenCode's enumeration per the #114 spike) fails fast, before
 *     any session is created, and reports the real available ids.
 *
 * Gated behind BOBODDY_INTEGRATION=true — see
 * `force-and-verify-mcp-health-check.integration.test.ts` for why.
 *
 * Run with:
 *   BOBODDY_INTEGRATION=true bun test tests/work/step-execution/integration/run-health-checks.integration.test.ts
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HealthCheck } from "@boboddy/sdk/health-checks";
import { runHealthChecks } from "../../../../src/work/step-execution/application/run-health-checks";
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

function buildCheck(
  overrides: Partial<HealthCheck> & { tool: string },
): HealthCheck {
  return {
    mcp: undefined,
    name: undefined,
    args: {},
    severity: "required",
    timeoutMs: 30_000,
    ...overrides,
  };
}

function echoCheck(overrides: Partial<HealthCheck> = {}): HealthCheck {
  return buildCheck({
    mcp: "fixture",
    tool: "echo",
    args: { text: "ping" },
    ...overrides,
  });
}

function boomCheck(overrides: Partial<HealthCheck> = {}): HealthCheck {
  return buildCheck({ mcp: "fixture", tool: "boom", ...overrides });
}

describe.skipIf(!integrationEnabled)("runHealthChecks (integration)", () => {
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
    "runs declared checks against a real OpenCode process and a real MCP server",
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

      // A single working MCP check passes.
      const working = await runHealthChecks({
        agentBaseUrl: environment.agentBaseUrl,
        workspaceFolder: environment.workspaceFolder,
        healthChecks: [echoCheck()],
        fakeAiServer,
      });
      expect(working).toEqual([
        {
          name: "fixture_echo",
          resolvedId: "fixture_echo",
          severity: "required",
          outcome: { kind: "passed" },
        },
      ]);

      // A single throwing MCP check fails with the tool's real error message.
      const broken = await runHealthChecks({
        agentBaseUrl: environment.agentBaseUrl,
        workspaceFolder: environment.workspaceFolder,
        healthChecks: [boomCheck()],
        fakeAiServer,
      });
      expect(broken).toHaveLength(1);
      expect(broken[0]?.outcome.kind).toBe("failed");
      if (broken[0]?.outcome.kind === "failed") {
        expect(broken[0].outcome.reason).toBe("tool-error");
        expect(broken[0].outcome.detail).toContain(
          "boom: intentionally broken fixture tool",
        );
      }

      // required checks run in declaration order; the first failure aborts
      // everything after it, including a later `warn` check.
      const orderedWithAbort = await runHealthChecks({
        agentBaseUrl: environment.agentBaseUrl,
        workspaceFolder: environment.workspaceFolder,
        healthChecks: [
          echoCheck({ name: "first (passes)" }),
          boomCheck({ name: "second (fails, aborts the rest)" }),
          echoCheck({ name: "third (required, never reached)" }),
          echoCheck({ name: "fourth (warn, never reached)", severity: "warn" }),
        ],
        fakeAiServer,
      });
      expect(
        orderedWithAbort.map((report) => ({
          name: report.name,
          kind: report.outcome.kind,
        })),
      ).toEqual([
        { name: "first (passes)", kind: "passed" },
        { name: "second (fails, aborts the rest)", kind: "failed" },
        { name: "third (required, never reached)", kind: "skipped" },
        { name: "fourth (warn, never reached)", kind: "skipped" },
      ]);

      // A tool that was never registered fails fast — before any session is
      // created — and reports the real ids OpenCode does know about. MCP
      // tools never appear in that enumeration (#114 spike), so this uses a
      // non-MCP (flat) tool id, matching the runner's degraded-for-MCP design.
      const startedAt = Date.now();
      const neverRegistered = await runHealthChecks({
        agentBaseUrl: environment.agentBaseUrl,
        workspaceFolder: environment.workspaceFolder,
        healthChecks: [
          buildCheck({ tool: "totally-fake-tool-that-does-not-exist" }),
        ],
        fakeAiServer,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(neverRegistered).toHaveLength(1);
      expect(neverRegistered[0]?.outcome.kind).toBe("failed");
      if (neverRegistered[0]?.outcome.kind === "failed") {
        expect(neverRegistered[0].outcome.reason).toBe("not-registered");
        expect(neverRegistered[0].outcome.availableIds).toBeDefined();
        expect(neverRegistered[0].outcome.availableIds?.length).toBeGreaterThan(
          0,
        );
      }
      // Real built-in tools (always registered) prove the enumeration was
      // genuinely queried, not stubbed.
      if (neverRegistered[0]?.outcome.kind === "failed") {
        expect(neverRegistered[0].outcome.availableIds).toContain("bash");
      }
      expect(elapsedMs).toBeLessThan(10_000);
    },
    TEST_TIMEOUT_MS,
  );
});
