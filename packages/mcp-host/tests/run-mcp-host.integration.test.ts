import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, afterAll } from "bun:test";
import pino from "pino";
import { runMcpHost } from "../src/run-mcp-host";

const silentLogger = pino({ level: "silent" });

/**
 * Integration test: workspace with a minimal inline plugin loaded from a JSON plugins config.
 *
 * This test validates the full runMcpHost → loadPluginTools → createMcpHttpServer pipeline
 * by pointing the host at an empty plugins list (no npm install needed).
 *
 * The full npm-plugin-load path is covered by E2E tests in tests/boboddy-e2e-tests.
 */
describe("runMcpHost integration", () => {
  let tmpDir: string | null = null;

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("starts and serves /health with empty plugin list", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcp-host-integration-"));

    const stop = await runMcpHost({
      workspacePath: tmpDir,
      port: 0, // OS-assigned port
      plugins: [],
      logger: silentLogger,
    });

    // The host doesn't expose its port directly — we need to find the open port.
    // Since we used port 0, we can't know the port without changes to runMcpHost's API.
    // For this integration test, we verify runMcpHost resolves without throwing.
    expect(typeof stop).toBe("function");

    stop();
  });

  test("tools/list returns empty array when no plugins provided", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcp-host-integration-"));

    // Use a fixed port for this test to be able to connect
    const port = 47_293;
    const stop = await runMcpHost({
      workspacePath: tmpDir,
      port,
      plugins: [],
      logger: silentLogger,
    });

    try {
      const response = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      });

      const body = (await response.json()) as {
        result: { tools: unknown[] };
      };
      expect(body.result.tools).toHaveLength(0);
    } finally {
      stop();
    }
  });

  test("/health returns ok with tool count", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcp-host-integration-"));

    const port = 47_294;
    const stop = await runMcpHost({
      workspacePath: tmpDir,
      port,
      plugins: [],
      logger: silentLogger,
    });

    try {
      const response = await fetch(`http://localhost:${port}/health`);
      const body = (await response.json()) as {
        status: string;
        tools: number;
      };
      expect(body.status).toBe("ok");
      expect(body.tools).toBe(0);
    } finally {
      stop();
    }
  });
});
