#!/usr/bin/env bun

import { $ } from "bun";
import { access, chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(projectRoot);

const publishDir = "./dist/npm-package";
const publishPackageJsonPath = `${publishDir}/package.json`;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const publishTag = args.find((arg) => !arg.startsWith("-")) ?? "latest";

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0;
}

async function preparePublishPackage() {
  try {
    await access("./dist");
  } catch {
    throw new Error("Missing CLI build output in dist/. Run the build step before publishing.");
  }

  await rm(publishDir, { recursive: true, force: true });
  await mkdir(`${publishDir}/bin`, { recursive: true });
  await mkdir(`${publishDir}/dist`, { recursive: true });
  await cp("./README.md", `${publishDir}/README.md`);
  for (const entry of await readdir("./dist")) {
    if (entry === "npm-package") {
      continue;
    }

    await cp(`./dist/${entry}`, `${publishDir}/dist/${entry}`, { recursive: true });
  }

  // Note: dist/devcontainers-cli.js is copied into dist/ by build.ts, so it
  // is already included above via the readdir loop. No separate copy needed.

  const wrapper = `#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const distDirectory = process.env.BOBODDY_DIST_DIR ?? resolve(projectRoot, "dist");
const platform = process.env.BOBODDY_PLATFORM ?? process.platform;
const arch = process.env.BOBODDY_ARCH ?? process.arch;
const binaryNames = {
  "darwin:arm64": "boboddy-darwin-arm64",
  "darwin:x64": "boboddy-darwin-x64",
  "linux:arm64": "boboddy-linux-arm64",
  "linux:x64": "boboddy-linux-x64",
  "win32:x64": "boboddy-windows-x64.exe",
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

const targetKey = platform + ":" + arch;
const binaryName = binaryNames[targetKey];

if (binaryName === undefined) {
  fail("Unsupported platform or architecture: " + platform + "/" + arch + ".");
}

const binaryPath = resolve(distDirectory, binaryName);
const devFilePath = resolve(distDirectory, ".dev");
const isDevBuild = existsSync(devFilePath);
const devSdkArtifactPath = isDevBuild ? readFileSync(devFilePath, "utf8").trim() : "";

if (!existsSync(binaryPath)) {
  fail("Missing compiled binary: " + binaryPath);
}

const extraEnv = {
  // Pass the devcontainer CLI bundle path so the worker can invoke it using
  // the compiled binary as the JS runtime (no separate node/bun required).
  BOBODDY_DEVCONTAINER_SCRIPT: resolve(distDirectory, "devcontainers-cli.js"),
};
if (devSdkArtifactPath) extraEnv.BOBODDY_SDK_ARTIFACT_PATH = devSdkArtifactPath;

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, ...extraEnv },
});

if (result.error instanceof Error) {
  fail(result.error.message);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
`;

  await Bun.write(`${publishDir}/bin/boboddy`, wrapper);
  await chmod(`${publishDir}/bin/boboddy`, 0o755);

  await Bun.write(
    publishPackageJsonPath,
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        bin: {
          boboddy: "bin/boboddy",
        },
        files: ["README.md", "bin", "dist"],
        repository: pkg.repository,
        publishConfig: pkg.publishConfig,
      },
      null,
      2,
    )}\n`,
  );
}

if (!dryRun && (await published(pkg.name, pkg.version))) {
  console.log(`already published ${pkg.name}@${pkg.version}`);
} else {
  await preparePublishPackage();
  const packOutput = await $`bun pm pack --quiet`.cwd(publishDir).text();
  const tarballName = packOutput.trim().split(/\r?\n/u).at(-1)?.trim();

  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`Expected bun pm pack to output a .tgz filename, got: ${packOutput}`);
  }

  if (dryRun) {
    console.log(`packed ${tarballName}`);
  } else {
    await $`npm publish ${tarballName} --access public --tag ${publishTag}`.cwd(publishDir);
  }
}
