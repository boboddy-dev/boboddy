import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import BoboddyOpencodePlugin from "./plugin";
import {
  BOBODDY_LIST_TOOLS_METHOD,
  BOBODDY_RPC_ID,
  type BoboddyListToolsOutput,
} from "./boboddy-rpc";
import { BOBODDY_SUBMIT_ARTIFACT_TOOL } from "./tools/boboddy-submit-artifact";
import { BOBODDY_SUBMIT_STEP_FINDINGS_TOOL } from "./tools/boboddy-submit-step-findings";

type RegisteredRpc = {
  definition: { id: string; methods: Record<string, unknown> };
  handlers: Record<string, (input: object) => Promise<BoboddyListToolsOutput>>;
};

function createFakeContext(directory: string) {
  const added: ToolInfo[] = [];
  const rpcs: RegisteredRpc[] = [];
  const registration = { dispose: () => Promise.resolve() };

  const context = {
    location: { directory },
    tool: {
      transform: (
        callback: (editor: { add(tool: ToolInfo): void }) => void,
      ) => {
        callback({ add: (tool) => added.push(tool) });
        return Promise.resolve(registration);
      },
      list: () =>
        Promise.resolve(added.map((tool) => ({ ...tool, id: tool.name }))),
    },
    rpc: {
      register: (
        definition: RegisteredRpc["definition"],
        handlers: RegisteredRpc["handlers"],
      ) => {
        rpcs.push({ definition, handlers });
        return Promise.resolve(registration);
      },
    },
  };

  return {
    context: context as unknown as Plugin.Context,
    added,
    rpcs,
  };
}

describe("BoboddyOpencodePlugin", () => {
  test("setup registers the Boboddy tools outside Code Mode", async () => {
    const { context, added } = createFakeContext("/workspace");

    await BoboddyOpencodePlugin.setup(context);

    expect(BoboddyOpencodePlugin.id).toBe("boboddy");
    expect(added.map((tool) => tool.name).sort()).toEqual([
      BOBODDY_SUBMIT_ARTIFACT_TOOL,
      BOBODDY_SUBMIT_STEP_FINDINGS_TOOL,
      "playwright-trace-analyzer",
    ]);
    for (const tool of added) {
      expect(tool.options?.codemode).toBe(false);
      expect(tool.input).toMatchObject({ type: "object" });
    }
  });

  test("setup registers the listTools RPC reporting each tool's input schema", async () => {
    const { context, added, rpcs } = createFakeContext("/workspace");

    await BoboddyOpencodePlugin.setup(context);

    expect(rpcs).toHaveLength(1);
    const [rpc] = rpcs;
    expect(rpc?.definition.id).toBe(BOBODDY_RPC_ID);
    const listTools = rpc?.handlers[BOBODDY_LIST_TOOLS_METHOD];
    expect(listTools).toBeDefined();

    const output = await listTools?.({});
    expect(output?.tools.map((tool) => tool.id).sort()).toEqual(
      added.map((tool) => tool.name).sort(),
    );
    const submit = output?.tools.find(
      (tool) => tool.id === BOBODDY_SUBMIT_STEP_FINDINGS_TOOL,
    );
    expect(submit?.inputSchema).toMatchObject({
      type: "object",
      required: ["findingsJson"],
    });
  });
});
