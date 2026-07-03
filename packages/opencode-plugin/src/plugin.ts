import type { PluginModule } from "@opencode-ai/plugin";
import boboddySubmitStepFindings from "./tools/boboddy-submit-step-findings";
import playwrightTraceAnalyzer from "./tools/playwright-trace-analyzer";

const BoboddyOpencodePlugin: PluginModule = {
  id: "boboddy",
  server: () => {
    return Promise.resolve({
      tool: {
        "boboddy-submit-step-findings": boboddySubmitStepFindings,
        "playwright-trace-analyzer": playwrightTraceAnalyzer,
      },
    });
  },
};

export default BoboddyOpencodePlugin;
