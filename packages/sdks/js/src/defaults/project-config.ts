import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "../jsonc";

export interface ProjectConfig {
  projectId: string;
}

const BOBODDY_DIR = ".boboddy";
const CONFIG_FILENAME = "boboddy.jsonc";

export const PROJECT_CONFIG_RELATIVE_PATH = path.join(BOBODDY_DIR, CONFIG_FILENAME);

function getConfigPath(rootDir: string): string {
  return path.join(rootDir, PROJECT_CONFIG_RELATIVE_PATH);
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isProjectConfig(value: unknown): value is ProjectConfig {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>)["projectId"] === "string";
}

export async function loadProjectConfig(
  rootDir: string = process.cwd(),
): Promise<ProjectConfig | null> {
  try {
    const content = await readFile(getConfigPath(rootDir), "utf8");
    const parsed = parseJsonc(content);
    return isProjectConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
