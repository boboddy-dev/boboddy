import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, PROJECT_CONFIG_RELATIVE_PATH } from "@boboddy/sdk/defaults";
import { parseJsonc } from "@boboddy/sdk/jsonc";

export { loadProjectConfig };

function getConfigPath(rootDir: string): string {
  return path.join(rootDir, PROJECT_CONFIG_RELATIVE_PATH);
}

async function readExistingConfigObject(configPath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = parseJsonc(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Writes `project` (`owner/slug`) into `.boboddy/boboddy.jsonc`, keeping every
 * other key already in the file (`branchPrefix`, `baseWorkBranch`, …). Drops
 * the retired `projectId` key.
 */
export async function saveProjectConfig(project: string, rootDir = process.cwd()): Promise<void> {
  const configPath = getConfigPath(rootDir);
  const existing = await readExistingConfigObject(configPath);
  const merged: Record<string, unknown> = { project, ...existing };
  merged["project"] = project;
  delete merged["projectId"];
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(merged, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function deriveProjectName(gitUrl: string): string {
  const lastSegment = gitUrl.split(/[/:]/u).pop() ?? gitUrl;
  return lastSegment.replace(/\.git$/u, "");
}
