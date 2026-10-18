import { existsSync, readdirSync, readFileSync } from "node:fs";

function readProcessCommandLines() {
  const commandLines = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const raw = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      const commandLine = raw.split("\0").join(" ").trim();
      if (commandLine) {
        commandLines.push(commandLine);
      }
    } catch {
      continue;
    }
  }
  return commandLines;
}

function integrationInspectingCodeStep() {
  const workspaceRoot = new URL("../../", import.meta.url);
  const commandLines = readProcessCommandLines();
  return {
    summary: "inspected runtime",
    opencodeProcesses: commandLines.filter((line) => /opencode/i.test(line)),
    processCount: commandLines.length,
    opencodePluginPresent: existsSync(
      new URL(".opencode/plugins/boboddy.js", workspaceRoot),
    ),
    opencodeDirectoryPresent: existsSync(new URL(".opencode", workspaceRoot)),
  };
}

export const inspectingStep = {
  key: "integration-step",
  name: "Integration Step",
  version: 1,
  kind: "code",
  entrypoint: { fn: integrationInspectingCodeStep },
};
