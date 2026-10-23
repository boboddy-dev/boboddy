import type { Plugin } from "@opencode/plugin";
import { createBoboddySubmitArtifactTool } from "./tools/boboddy-submit-artifact";
import { createBoboddySubmitStepFindingsTool } from "./tools/boboddy-submit-step-findings";
import { createPlaywrightTraceAnalyzerTool } from "./tools/playwright-trace-analyzer";
import { BOBODDY_RPC_DEFINITION, describeRegisteredTools } from "./boboddy-rpc";

/**
 * The Boboddy OpenCode plugin: registers Boboddy's tools, and exposes a
 * `boboddy.listTools` RPC so the worker can enumerate registered tool ids and
 * input schemas (v2 has no server route for that).
 *
 * A plain object rather than `Plugin.define(...)`: `define` is an identity
 * function, and avoiding the runtime import keeps the bundled
 * `.opencode/plugins/boboddy.js` free of any module it would have to resolve
 * from the user's workspace.
 */
const BoboddyOpencodePlugin: Plugin.Plugin = {
  id: "boboddy",
  async setup(ctx) {
    const submitArtifactTool = await createBoboddySubmitArtifactTool(
      ctx.location.directory,
    );
    await ctx.tool.transform((editor) => {
      editor.add(createBoboddySubmitStepFindingsTool(ctx.location.directory));
      editor.add(submitArtifactTool);
      editor.add(createPlaywrightTraceAnalyzerTool());
    });
    await ctx.rpc.register(BOBODDY_RPC_DEFINITION, {
      listTools: async () => ({
        tools: describeRegisteredTools(await ctx.tool.list()),
      }),
    });
  },
};

export default BoboddyOpencodePlugin;
