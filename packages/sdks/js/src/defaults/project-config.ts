import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "../jsonc";

export interface ProjectConfig {
  projectId: string;
  /**
   * Optional prefix for the per-step work branch name. The worker creates
   * branches named `<branchPrefix>/<stepKey>-<stepExecutionId>`. Defaults to
   * `boboddy` when omitted or invalid.
   */
  branchPrefix?: string;
  /**
   * Optional base branch the FIRST step's work branch is created off of. The
   * worker clones the repo's default HEAD, then checks out this branch before
   * branching. Overridden by the `BOBODDY_BASE_WORK_BRANCH` env var in
   * `.boboddy/.env`. Ignored for later steps, which are always created off the
   * predecessor step's work branch. Defaults to the repo's default branch when
   * omitted or invalid.
   */
  baseWorkBranch?: string;
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
  const record = value as Record<string, unknown>;
  if (typeof record["projectId"] !== "string") return false;
  // `branchPrefix` is optional, but when present it must be a string.
  if ("branchPrefix" in record && typeof record["branchPrefix"] !== "string") {
    return false;
  }
  // `baseWorkBranch` is optional, but when present it must be a string.
  if (
    "baseWorkBranch" in record &&
    typeof record["baseWorkBranch"] !== "string"
  ) {
    return false;
  }
  return true;
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
