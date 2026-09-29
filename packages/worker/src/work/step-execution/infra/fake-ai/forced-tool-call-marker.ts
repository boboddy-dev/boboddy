/**
 * The machine-readable "forced tool call" marker `FakeAiServer` (see
 * `fake-ai-server.ts`) uses to resolve which tool/args to force PER REQUEST,
 * instead of from its own shared, mutable `configure()` state.
 *
 * Split out of `fake-ai-server.ts` to keep that file under the repo's
 * `max-lines` limit; `buildForcedToolCallPrompt` and
 * `parseForcedToolCallFromMessages` are a matched pair and belong together
 * regardless of which file they live in — see `fake-ai-server.ts`'s file
 * comment for why this exists (concurrent health checks sharing one
 * `FakeAiServer` instance — #119/#122).
 */

type MessageContentBlock = { type: string; text?: string };

/** The minimal shape this module needs from an Anthropic-format message. */
export type MarkerCarryingMessage = {
  role: "user" | "assistant";
  content: string | MessageContentBlock[];
};

export type ForcedToolCall = {
  toolName: string;
  toolArgs: unknown;
};

/**
 * Delimits the marker {@link buildForcedToolCallPrompt} appends to its
 * human-readable prompt text, and {@link parseForcedToolCallFromMessages}
 * reads back out. Not expected to collide with real prompt content —
 * nothing else in this codebase emits it.
 */
const FORCED_TOOL_CALL_MARKER_START = "<<boboddy-forced-tool-call>>";
const FORCED_TOOL_CALL_MARKER_END = "<</boboddy-forced-tool-call>>";

/**
 * Builds the prompt text a caller that might run concurrently with other
 * forced calls against the same `FakeAiServer` instance (currently: only the
 * health-check runner, see `fake-ai-server.ts`) must use instead of an
 * arbitrary hand-written prompt. Embeds `toolName`/`toolArgs` in a marker
 * {@link parseForcedToolCallFromMessages} parses back out per-request, so the
 * server never has to depend on `FakeAiServer.configure` having been called
 * for the right check.
 */
export function buildForcedToolCallPrompt(
  toolName: string,
  // eslint-disable-next-line local/no-unknown-parameter-type -- toolArgs is caller-supplied JSON, not a real input boundary
  toolArgs: unknown,
): string {
  const payload = JSON.stringify({ toolName, toolArgs });
  return `Call the ${toolName} tool to verify it works. ${FORCED_TOOL_CALL_MARKER_START}${payload}${FORCED_TOOL_CALL_MARKER_END}`;
}

function extractMessageText(
  content: MarkerCarryingMessage["content"],
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * Reads a {@link buildForcedToolCallPrompt} marker back out of the last
 * `user`-role message in `messages`, if there is one. Returns `undefined` —
 * NOT a failure — for every request that didn't originate from that helper
 * (the regular step-execution agent's real prompts, worker/e2e fixtures that
 * call `FakeAiServer.configure` directly), so callers should fall back to
 * `configure()`'s last value in that case.
 */
export function parseForcedToolCallFromMessages(
  messages: MarkerCarryingMessage[],
): ForcedToolCall | undefined {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!lastUserMessage) {
    return undefined;
  }

  const text = extractMessageText(lastUserMessage.content);
  const start = text.indexOf(FORCED_TOOL_CALL_MARKER_START);
  const end = text.indexOf(FORCED_TOOL_CALL_MARKER_END);
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  const payloadText = text.slice(
    start + FORCED_TOOL_CALL_MARKER_START.length,
    end,
  );
  try {
    const payload = JSON.parse(payloadText) as {
      toolName?: unknown;
      toolArgs?: unknown;
    };
    if (typeof payload.toolName !== "string") {
      return undefined;
    }
    return { toolName: payload.toolName, toolArgs: payload.toolArgs };
  } catch {
    return undefined;
  }
}
