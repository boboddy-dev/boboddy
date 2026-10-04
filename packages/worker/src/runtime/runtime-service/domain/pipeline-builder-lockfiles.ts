/**
 * The lockfiles `.boboddy/pipeline-builder` may carry and the package manager
 * each one belongs to. Shared by the CLI (which installs on the author's
 * machine) and the managed runtime install (which installs in the container),
 * so a lockfile means the same thing in both.
 */

export type BuilderInstaller = {
  /** Executable to spawn. */
  command: string;
  /** Arguments. */
  args: readonly string[];
  /** Human-readable command, for status lines and error messages. */
  label: string;
};

/**
 * Lockfile → installer, in priority order: when several are present the first
 * one wins, so an existing project keeps using the package manager it was set
 * up with.
 */
export const PIPELINE_BUILDER_LOCKFILES = [
  {
    name: "bun.lock",
    installer: { command: "bun", args: ["install"], label: "bun install" },
  },
  {
    name: "bun.lockb",
    installer: { command: "bun", args: ["install"], label: "bun install" },
  },
  {
    name: "pnpm-lock.yaml",
    installer: { command: "pnpm", args: ["install"], label: "pnpm install" },
  },
  {
    name: "yarn.lock",
    installer: { command: "yarn", args: ["install"], label: "yarn install" },
  },
  {
    name: "package-lock.json",
    installer: { command: "npm", args: ["install"], label: "npm install" },
  },
  {
    name: "deno.lock",
    installer: { command: "deno", args: ["install"], label: "deno install" },
  },
  {
    name: "deno.json",
    installer: { command: "deno", args: ["install"], label: "deno install" },
  },
] as const satisfies ReadonlyArray<{
  name: string;
  installer: BuilderInstaller;
}>;

export type PipelineBuilderLockfileName =
  (typeof PIPELINE_BUILDER_LOCKFILES)[number]["name"];

/** The first lockfile in {@link PIPELINE_BUILDER_LOCKFILES} order that is present. */
export function selectPipelineBuilderLockfile(
  present: ReadonlySet<PipelineBuilderLockfileName>,
): PipelineBuilderLockfileName | null {
  return (
    PIPELINE_BUILDER_LOCKFILES.find((lockfile) => present.has(lockfile.name))
      ?.name ?? null
  );
}
