import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "../jsonc";

export interface ProjectConfig {
  /**
   * The project this repo belongs to, as `<owner>/<slug>` — the owner's
   * username and the project slug, the same pair as the project's web URL.
   */
  project: string;
  /**
   * Optional prefix for the per-step work branch name. The worker creates
   * branches named `<branchPrefix>/<stepKey>-<taskId>`. Defaults to
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

export interface ProjectRef {
  owner: string;
  slug: string;
}

/**
 * Mirrors the server's username (3–32) and project slug (1–64) rules:
 * lowercase alphanumerics separated by single hyphens. Duplicated here because
 * the SDK cannot depend on the server packages.
 */
const REF_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const OWNER_MIN_LENGTH = 3;
const OWNER_MAX_LENGTH = 32;
const SLUG_MAX_LENGTH = 64;

/** Parses `<owner>/<slug>`, or returns `null` when either half breaks the rules. */
export function parseProjectRef(ref: string): ProjectRef | null {
  const parts = ref.split("/");
  if (parts.length !== 2) return null;
  const [owner = "", slug = ""] = parts;
  if (
    owner.length < OWNER_MIN_LENGTH ||
    owner.length > OWNER_MAX_LENGTH ||
    !REF_SEGMENT_PATTERN.test(owner)
  ) {
    return null;
  }
  if (slug.length > SLUG_MAX_LENGTH || !REF_SEGMENT_PATTERN.test(slug)) {
    return null;
  }
  return { owner, slug };
}

export function isProjectRef(ref: string): boolean {
  return parseProjectRef(ref) !== null;
}

export function formatProjectRef(ref: ProjectRef): string {
  return `${ref.owner}/${ref.slug}`;
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
  const project = record["project"];
  if (typeof project !== "string" || !isProjectRef(project)) return false;
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
