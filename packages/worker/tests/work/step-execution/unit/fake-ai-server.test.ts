import { afterEach, describe, expect, test } from "bun:test";
import {
  buildForcedToolCallPrompt,
  FakeAiServer,
} from "../../../../src/work/step-execution/infra/fake-ai/fake-ai-server";

/**
 * Regression coverage for the concurrency fix `runHealthChecks` (#119/#122)
 * depends on: several checks can now force calls against ONE shared
 * `FakeAiServer` instance at the same time (parallel `serialGroup` lanes —
 * see `run-health-checks.ts`). Before this fix, `FakeAiServer` decided which
 * tool to force purely from `configure()`'s last call — shared, mutable,
 * per-instance state — so a second concurrent `configure()` call could race
 * ahead of the first request that was meant to read it and corrupt which
 * tool a session's forced call actually names. `buildForcedToolCallPrompt`
 * embeds the tool/args directly in the prompt text instead, so each request
 * is self-describing regardless of arrival order — these tests prove that
 * end to end over real HTTP against a real `FakeAiServer`.
 */
describe("FakeAiServer — concurrent forced tool calls", () => {
  let server: FakeAiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function postMessages(
    port: number,
    body: Record<string, unknown>,
  ): Promise<{ content: { type: string; name?: string; input?: unknown }[] }> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: false }),
    });
    return (await response.json()) as {
      content: { type: string; name?: string; input?: unknown }[];
    };
  }

  function toolUsePart(response: {
    content: { type: string; name?: string; input?: unknown }[];
  }) {
    return response.content.find((block) => block.type === "tool_use");
  }

  test("a request whose prompt was built by buildForcedToolCallPrompt forces that tool/args, even when configure() was called for something else", async () => {
    server = new FakeAiServer();
    const port = await server.start();

    // Simulates the exact race the fix closes: `configure()` was last called
    // for a completely different tool (as another concurrent check would
    // have done), but this request's own prompt names its own tool.
    server.configure("wrong-tool-from-another-check", { wrong: true });

    const response = await postMessages(port, {
      messages: [
        {
          role: "user",
          content: buildForcedToolCallPrompt("real_tool", { the: "args" }),
        },
      ],
    });

    const toolUse = toolUsePart(response);
    expect(toolUse?.name).toBe("real_tool");
    expect(toolUse?.input).toEqual({ the: "args" });
  });

  test("two concurrent requests built with buildForcedToolCallPrompt each get their own tool, never the other's", async () => {
    server = new FakeAiServer();
    const port = await server.start();

    const [responseA, responseB] = await Promise.all([
      postMessages(port, {
        messages: [
          {
            role: "user",
            content: buildForcedToolCallPrompt("tool_a", { id: "a" }),
          },
        ],
      }),
      postMessages(port, {
        messages: [
          {
            role: "user",
            content: buildForcedToolCallPrompt("tool_b", { id: "b" }),
          },
        ],
      }),
    ]);

    expect(toolUsePart(responseA)?.name).toBe("tool_a");
    expect(toolUsePart(responseA)?.input).toEqual({ id: "a" });
    expect(toolUsePart(responseB)?.name).toBe("tool_b");
    expect(toolUsePart(responseB)?.input).toEqual({ id: "b" });
  });

  test("falls back to configure() when the prompt has no marker (the non-health-check, non-concurrent caller)", async () => {
    server = new FakeAiServer();
    const port = await server.start();
    server.configure("boboddy-submit-step-findings", { ok: true });

    const response = await postMessages(port, {
      messages: [{ role: "user", content: "Please do the assigned task." }],
    });

    const toolUse = toolUsePart(response);
    expect(toolUse?.name).toBe("boboddy-submit-step-findings");
    expect(toolUse?.input).toEqual({ ok: true });
  });
});
