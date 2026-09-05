#!/usr/bin/env bun

/**
 * Publishes the CLI to npm as a thin `@boboddy/cli` package plus one
 * `@boboddy/cli-<platform>-<arch>` optionalDependency package per compiled
 * binary (see targets.ts).
 *
 * Why split it up: every platform's binary used to ship inside the single
 * `@boboddy/cli` tarball (~170MB combined across 5 binaries). A plain
 * `npm install -g @boboddy/cli` therefore had to download and atomically
 * extract all of that on every install/upgrade, on every platform — and a
 * large multi-file extraction that gets interrupted (network blip, disk
 * pressure, a stray leftover temp dir from a previous failed install
 * colliding with npm's rename-based swap) can leave a partially-extracted,
 * silently-broken install behind: e.g. the binaries land but a file later in
 * the tarball — like the bundled devcontainer CLI — never gets extracted.
 * bin/boboddy's own integrity checks now fail loudly when that happens, but
 * shrinking each install to one ~70-90MB platform package (the npm/optional
 * dependency pattern used by esbuild, @swc/core, rollup, turbo, etc.) makes
 * the underlying interrupted-extraction failure far less likely in the first
 * place, and confines any corruption to a single, independently-reinstallable
 * package instead of the whole CLI.
 *
 * Publish order matters: platform packages are published before the main
 * package, so that by the time `@boboddy/cli`'s optionalDependencies are
 * resolvable, the versions they pin already exist on the registry.
 *
 * One catch with the optionalDependency pattern itself: npm treats a failed
 * optionalDependency as a *non-fatal* skip — `npm install -g @boboddy/cli`
 * can exit 0 with the platform package silently missing (a dropped
 * connection fetching that ~90MB package, not just corruption, is enough).
 * That traded a rare corrupted-extraction failure for a more common silent
 * one. bin/postinstall.js (see its own module doc) closes that gap: it's the
 * main package's own postinstall script, so unlike a skipped
 * optionalDependency, *its* failures do fail `npm install` loudly.
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";
import { CLI_BUILD_TARGETS } from "./targets";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(projectRoot);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const publishTag = args.find((arg) => !arg.startsWith("-")) ?? "latest";

// pino/pino-pretty versions must match apps/cli/package.json — bin/boboddy
// (copied verbatim into the published package, see below) requires both.
const WRAPPER_DEPENDENCIES: Record<string, string> = {
  pino: pkg.dependencies.pino,
  "pino-pretty": pkg.dependencies["pino-pretty"],
};

async function published(name: string, version: string): Promise<boolean> {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0;
}

async function packAndPublish(publishDir: string): Promise<void> {
  const packOutput = await $`bun pm pack --quiet`.cwd(publishDir).text();
  const tarballName = packOutput.trim().split(/\r?\n/u).at(-1)?.trim();

  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`Expected bun pm pack to output a .tgz filename, got: ${packOutput}`);
  }

  if (dryRun) {
    console.warn(`packed ${tarballName}`);
  } else {
    await $`npm publish ${tarballName} --access public --tag ${publishTag}`.cwd(publishDir);
  }
}

async function publishIfNeeded(name: string, version: string, prepare: () => Promise<string>): Promise<void> {
  if (!dryRun && (await published(name, version))) {
    console.warn(`already published ${name}@${version}`);
    return;
  }
  const publishDir = await prepare();
  await packAndPublish(publishDir);
}

/** Build `dist/npm-package-<platform>-<arch>/`: just the one compiled binary. */
async function preparePlatformPackage(target: (typeof CLI_BUILD_TARGETS)[number]): Promise<string> {
  const publishDir = `./dist/npm-package-${target.platform}-${target.arch}`;
  const binarySrc = `./dist/${target.outputName}`;

  if (!existsSync(binarySrc)) {
    throw new Error(`Missing compiled binary ${binarySrc}. Run the build step before publishing.`);
  }

  await rm(publishDir, { recursive: true, force: true });
  await mkdir(`${publishDir}/bin`, { recursive: true });
  await cp(binarySrc, `${publishDir}/bin/${target.outputName}`);
  await chmod(`${publishDir}/bin/${target.outputName}`, 0o755);

  await Bun.write(
    `${publishDir}/package.json`,
    `${JSON.stringify(
      {
        name: target.packageName,
        version: pkg.version,
        description: `${target.platform}/${target.arch} binary for @boboddy/cli. Not for direct use.`,
        os: [target.platform],
        cpu: [target.arch],
        files: ["bin"],
        repository: pkg.repository,
        publishConfig: pkg.publishConfig,
      },
      null,
      2,
    )}\n`,
  );

  return publishDir;
}

/**
 * Build `dist/npm-package/`: the thin main package. Ships bin/boboddy and
 * bin/postinstall.js verbatim (the real dev shim and install-time integrity
 * check, not separately-maintained copies — those used to drift from the
 * published artifact) plus the shared devcontainer CLI bundle. No platform
 * binaries: those come from the optionalDependency packages published above,
 * with bin/postinstall.js verifying + repairing that at install time (see its
 * module doc for why an optionalDependency alone isn't enough here).
 */
async function prepareMainPackage(): Promise<string> {
  const publishDir = "./dist/npm-package";
  const devcontainerSrc = "./dist/devcontainer";

  if (!existsSync(devcontainerSrc)) {
    throw new Error(`Missing ${devcontainerSrc}. Run the build step before publishing.`);
  }

  await rm(publishDir, { recursive: true, force: true });
  await mkdir(`${publishDir}/bin`, { recursive: true });
  await mkdir(`${publishDir}/dist`, { recursive: true });
  await cp("./README.md", `${publishDir}/README.md`);
  await cp("./bin/boboddy", `${publishDir}/bin/boboddy`);
  await chmod(`${publishDir}/bin/boboddy`, 0o755);
  await cp("./bin/postinstall.js", `${publishDir}/bin/postinstall.js`);
  await chmod(`${publishDir}/bin/postinstall.js`, 0o755);
  await cp(devcontainerSrc, `${publishDir}/dist/devcontainer`, { recursive: true });

  const optionalDependencies = Object.fromEntries(
    CLI_BUILD_TARGETS.map((target) => [target.packageName, pkg.version]),
  );

  await Bun.write(
    `${publishDir}/package.json`,
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        bin: {
          boboddy: "bin/boboddy",
        },
        scripts: {
          postinstall: "node bin/postinstall.js",
        },
        files: ["README.md", "bin", "dist"],
        dependencies: WRAPPER_DEPENDENCIES,
        optionalDependencies,
        repository: pkg.repository,
        publishConfig: pkg.publishConfig,
      },
      null,
      2,
    )}\n`,
  );

  return publishDir;
}

if (!existsSync("./dist")) {
  throw new Error("Missing CLI build output in dist/. Run the build step before publishing.");
}

// Guard against dist/npm-package* leaking into itself: prepareMainPackage()
// copies specific subpaths (README, bin/boboddy, dist/devcontainer) rather
// than the whole dist/ directory, so stale npm-package* output from a
// previous run can't get recursively re-bundled. Clean any of it up first.
for (const entry of await readdir("./dist")) {
  if (entry.startsWith("npm-package")) {
    await rm(`./dist/${entry}`, { recursive: true, force: true });
  }
}

for (const target of CLI_BUILD_TARGETS) {
  await publishIfNeeded(target.packageName, pkg.version, () => preparePlatformPackage(target));
}

await publishIfNeeded(pkg.name, pkg.version, prepareMainPackage);
