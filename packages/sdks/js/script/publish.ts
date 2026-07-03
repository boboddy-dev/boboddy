#!/usr/bin/env bun

import { $ } from "bun";
import { fileURLToPath } from "node:url";
import { withDistExportsPackage } from "./package-with-dist-exports";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(projectRoot);

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0;
}

const tag = process.argv[2] ?? "latest";
const pkg = JSON.parse(await Bun.file("package.json").text()) as {
  name: string;
  version: string;
};

if (await published(pkg.name, pkg.version)) {
  console.warn(`already published ${pkg.name}@${pkg.version}`);
} else {
  await $`bun run build`;

  await withDistExportsPackage(projectRoot, async () => {
    await $`bun pm pack`;
    await $`npm publish *.tgz --tag ${tag} --access public`;
  });
}
