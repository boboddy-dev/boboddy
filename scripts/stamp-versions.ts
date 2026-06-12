#!/usr/bin/env bun

/**
 * Stamps a release version into all publishable packages.
 *
 * Usage:
 *   bun run scripts/stamp-versions.ts <version>
 *
 * Sets:
 *   - packages/sdks/js          → version
 *   - packages/opencode-plugin  → version, dependencies.@boboddy/sdk
 *                                 removes dependencies.@opencode-ai/sdk and dependencies.ajv
 *   - apps/cli                  → version
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const version = process.argv[2];

if (!version) {
  process.stderr.write("Usage: bun run scripts/stamp-versions.ts <version>\n");
  process.exit(1);
}

const repoRoot = resolve(import.meta.dir, "..");

type PackageJson = Record<string, unknown> & {
  dependencies?: Record<string, string>;
};

async function readPackageJson(pkgPath: string): Promise<PackageJson> {
  return JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
}

async function writePackageJson(pkgPath: string, pkg: PackageJson): Promise<void> {
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

async function stampPackage(
  relPath: string,
  mutate: (pkg: PackageJson) => void,
): Promise<void> {
  const pkgPath = resolve(repoRoot, relPath, "package.json");
  const pkg = await readPackageJson(pkgPath);
  mutate(pkg);
  await writePackageJson(pkgPath, pkg);
  process.stdout.write(`stamped ${relPath} → ${version}\n`);
}

await stampPackage("packages/sdks/js", (pkg) => {
  pkg.version = version;
});

await stampPackage("packages/opencode-plugin", (pkg) => {
  pkg.version = version;
  pkg.dependencies ??= {};
  pkg.dependencies["@boboddy/sdk"] = `^${version}`;
  delete pkg.dependencies["@opencode-ai/sdk"];
  delete pkg.dependencies["ajv"];
});

await stampPackage("apps/cli", (pkg) => {
  pkg.version = version;
});
