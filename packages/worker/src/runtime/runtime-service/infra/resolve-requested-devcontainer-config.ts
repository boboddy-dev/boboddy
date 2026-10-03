import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { devcontainerConfigPathSchema } from "@boboddy/sdk/devcontainer-config-path";

/**
 * Resolves a step's explicitly requested devcontainer config inside a cloned
 * workspace. There is deliberately no fallback search: a step that names a
 * config must run in that container or not at all.
 *
 * The path is validated with the shared schema (repo-relative, `devcontainer.json`
 * basename, no `..`), then its `realpath` is checked to stay inside the
 * workspace's own `realpath`, so a symlink committed to the repo cannot point the
 * launcher at a file outside the clone. Returns the normalized repo-relative path.
 */
export async function resolveRequestedDevcontainerConfig(input: {
  workspacePath: string;
  configPath: string;
}): Promise<string> {
  const parsed = devcontainerConfigPathSchema.safeParse(input.configPath);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(
      `Devcontainer config "${input.configPath}" is not a valid path: ${reason}`,
    );
  }
  const relativePath = parsed.data;
  const absolutePath = path.join(input.workspacePath, relativePath);

  let realWorkspace: string;
  let realConfig: string;
  try {
    realWorkspace = await realpath(input.workspacePath);
    realConfig = await realpath(absolutePath);
  } catch {
    throw notFound(input.configPath);
  }

  if (!isWithin(realWorkspace, realConfig)) {
    throw new Error(
      `Devcontainer config "${input.configPath}" resolves outside the cloned repository`,
    );
  }

  try {
    await access(absolutePath);
  } catch {
    throw notFound(input.configPath);
  }
  return relativePath;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function notFound(configPath: string): Error {
  return new Error(
    `Devcontainer config "${configPath}" not found in the cloned repository`,
  );
}
