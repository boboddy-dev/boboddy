import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentToolsManifestPath,
  type AgentToolsManifest,
} from "../domain/agent-tools-manifest";

/**
 * Write `manifest` to `~/.boboddy/projects/<owner>/<slug>/discovered-tools.json`
 * (see {@link agentToolsManifestPath}), replacing any earlier one, and return
 * the absolute path.
 */
export async function writeAgentToolsManifest(input: {
  homeDir: string;
  owner: string;
  slug: string;
  manifest: AgentToolsManifest;
}): Promise<string> {
  const file = agentToolsManifestPath(input);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(input.manifest, null, 2)}\n`, "utf8");
  return file;
}
