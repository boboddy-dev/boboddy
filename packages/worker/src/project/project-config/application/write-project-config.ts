import { saveProjectConfig } from "../infra/fs-project-config-repo";

/** Writes `project` (an `owner/slug` ref) into `.boboddy/boboddy.jsonc`, merging with what's there. */
export async function writeProjectConfig(project: string, rootDir = process.cwd()) {
  await saveProjectConfig(project, rootDir);
}
