#!/usr/bin/env bun

import { $ } from "bun";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withDistExportsPackage } from "./package-with-dist-exports";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(projectRoot);

const artifactsDir = resolve(projectRoot, ".artifacts");
// The artifact filename must change on each build so Bun treats it as a new
// dependency source and reinstalls it in sibling apps instead of reusing a
// cached package from the same absolute tarball path.
const outputPath = resolve(
  artifactsDir,
  `boboddy-sdk-local-${String(Date.now())}.tgz`,
);

await $`bun run build`;
await mkdir(artifactsDir, { recursive: true });

for (const entry of await readdir(artifactsDir).catch(() => [])) {
  if (entry.startsWith("boboddy-sdk-local-") && entry.endsWith(".tgz")) {
    await rm(resolve(artifactsDir, entry), { force: true });
  }
}

const packOutput = await withDistExportsPackage(projectRoot, async () =>
  $`bun pm pack --quiet`.text(),
);
const tarballName = packOutput.trim().split(/\r?\n/u).at(-1)?.trim();

if (!tarballName?.endsWith(".tgz")) {
  throw new Error(
    `Expected bun pm pack to output a .tgz filename, got: ${packOutput}`,
  );
}

await rename(resolve(projectRoot, basename(tarballName)), outputPath);

// Print the artifact path to stdout so callers (e.g. scripts/cli-link-dev.sh)
// can capture it via command substitution. This is the script's machine-
// readable output; all human-facing build logs go to stderr. Do NOT switch
// this to console.warn/console.error — that sends the path to stderr and the
// shell captures an empty string, silently disabling the local SDK bundle.

// eslint-disable-next-line no-console
console.log(outputPath);
