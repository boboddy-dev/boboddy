import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, PROJECT_CONFIG_RELATIVE_PATH } from "@boboddy/sdk/defaults";

export { loadProjectConfig };

function getConfigPath(rootDir: string): string {
  return path.join(rootDir, PROJECT_CONFIG_RELATIVE_PATH);
}

export async function saveProjectConfig(projectId: string, rootDir = process.cwd()): Promise<void> {
  const configDir = path.dirname(getConfigPath(rootDir));
  await mkdir(configDir, { recursive: true });
  await writeFile(getConfigPath(rootDir), JSON.stringify({ projectId }, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function deriveProjectName(gitUrl: string): string {
  const lastSegment = gitUrl.split(/[/:]/u).pop() ?? gitUrl;
  return lastSegment.replace(/\.git$/u, "");
}
