import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ManagedRuntimeId } from "@boboddy/sdk/managed-runtimes";
import { PIPELINE_BUILDER_DIR } from "@boboddy/sdk/push";
import {
  MANAGED_DEVCONTAINERS_DIR,
  MANAGED_RUNTIMES,
} from "../domain/managed-runtimes";
import { buildPipelineBuilderInstallCommand } from "../domain/pipeline-builder-install-command";
import {
  PIPELINE_BUILDER_LOCKFILES,
  type PipelineBuilderLockfileName,
} from "../domain/pipeline-builder-lockfiles";

/**
 * Synthesizes the `devcontainer.json` a managed runtime launches with. The
 * config is written into the clone, so the launcher and the patchers resolve it
 * exactly like a repo-owned config; nothing else about the launch changes.
 */

/** Workspace-relative POSIX path of the config for `id`. */
export function managedRuntimeConfigPath(id: ManagedRuntimeId): string {
  return path.posix.join(MANAGED_DEVCONTAINERS_DIR, id, "devcontainer.json");
}

/**
 * The config as JSON text: `image`, `remoteUser` and an `onCreateCommand` that
 * installs the pipeline-builder dependencies. No cache volume.
 *
 * `patchDevcontainerEnv` strips `//...` with a regex before `JSON.parse`, so a
 * `//` inside any string (a URL in a command, say) would corrupt the config
 * downstream. Rendering refuses to produce one.
 */
export function renderManagedRuntimeConfig(input: {
  id: ManagedRuntimeId;
  lockfilePresence: ReadonlySet<PipelineBuilderLockfileName>;
}): string {
  const definition = MANAGED_RUNTIMES[input.id];
  const rendered = JSON.stringify(
    {
      name: `boboddy-managed-${input.id}`,
      image: definition.image,
      remoteUser: definition.remoteUser,
      onCreateCommand: buildPipelineBuilderInstallCommand({
        present: input.lockfilePresence,
        definition,
      }),
    },
    null,
    2,
  );
  if (rendered.includes("//")) {
    throw new Error(
      `Managed runtime "${input.id}" rendered a config containing "//", which the devcontainer patcher would strip as a comment.`,
    );
  }
  return `${rendered}\n`;
}

async function readLockfilePresence(
  workspacePath: string,
): Promise<ReadonlySet<PipelineBuilderLockfileName>> {
  const builderDir = path.join(workspacePath, PIPELINE_BUILDER_DIR);
  const present = new Set<PipelineBuilderLockfileName>();
  for (const { name } of PIPELINE_BUILDER_LOCKFILES) {
    try {
      await access(path.join(builderDir, name));
      present.add(name);
    } catch {
      continue;
    }
  }
  return present;
}

/**
 * Write the managed config for `id` into the clone, choosing the install from
 * the lockfile the clone's pipeline-builder carries. Returns the
 * workspace-relative config path, to use where `resolveDevcontainerConfig`
 * would have returned one.
 */
export async function writeManagedRuntimeConfig(input: {
  workspacePath: string;
  id: ManagedRuntimeId;
}): Promise<string> {
  const relativePath = managedRuntimeConfigPath(input.id);
  const content = renderManagedRuntimeConfig({
    id: input.id,
    lockfilePresence: await readLockfilePresence(input.workspacePath),
  });
  const absolutePath = path.join(input.workspacePath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return relativePath;
}
