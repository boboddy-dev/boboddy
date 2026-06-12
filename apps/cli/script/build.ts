import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { version as packageVersion } from "../package.json";

const require = createRequire(import.meta.url);

interface BuildTarget {
  readonly bunTarget: string;
  readonly outputName: string;
  readonly codesign?: boolean;
}

const CLI_NAME = "boboddy";
const projectRoot = resolve(import.meta.dir, "..");
const distDirectory = resolve(projectRoot, "dist");
const entrypoint = resolve(projectRoot, "src/index.ts");

const allTargets: readonly BuildTarget[] = [
  {
    bunTarget: "bun-darwin-arm64",
    outputName: `${CLI_NAME}-darwin-arm64`,
    codesign: true,
  },
  {
    bunTarget: "bun-darwin-x64",
    outputName: `${CLI_NAME}-darwin-x64`,
    codesign: true,
  },
  { bunTarget: "bun-linux-x64", outputName: `${CLI_NAME}-linux-x64` },
  { bunTarget: "bun-linux-arm64", outputName: `${CLI_NAME}-linux-arm64` },
  { bunTarget: "bun-windows-x64", outputName: `${CLI_NAME}-windows-x64.exe` },
];

async function buildTarget(
  target: BuildTarget,
  extraDefines: readonly string[] = [],
): Promise<void> {
  const outfile = resolve(distDirectory, target.outputName);
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "build",
      entrypoint,
      "--compile",
      `--target=${target.bunTarget}`,
      `--outfile=${outfile}`,
      // node-gyp is referenced by @npmcli/arborist for native rebuilds, but the
      // MCP host runs arborist with `ignoreScripts: true`, so it is never
      // invoked. Externalize it so `bun build --compile` doesn't try to bundle
      // its bin paths (matches OpenCode's build, packages/opencode/script/build.ts).
      "--external=node-gyp",
      ...extraDefines,
    ],
    {
      cwd: projectRoot,
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const exitCode = await subprocess.exited;

  if (exitCode !== 0) {
    throw new Error(`Build failed for ${target.bunTarget}.`);
  }

  if (target.codesign && process.platform === "darwin") {
    process.stdout.write(`Signing ${target.outputName}...\n`);
    // CI signs darwin binaries in the sign-cli-macos workflow job instead.
    // This branch only runs for local macOS builds.
    // Bun --compile embeds the JS bundle after the initial binary signature,
    // leaving an invalid LC_CODE_SIGNATURE. Strip it before re-signing.
    const stripProc = Bun.spawn(["codesign", "--remove-signature", outfile], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await stripProc.exited;
    const signProc = Bun.spawn(
      ["codesign", "--sign", "-", "--force", outfile],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const signExit = await signProc.exited;
    if (signExit !== 0) {
      throw new Error(`codesign failed for ${target.outputName}.`);
    }
  }
}

async function main(): Promise<void> {
  const isDev = process.argv.includes("--dev");
  const cliVersion = process.env["CLI_BUILD_VERSION"] ?? packageVersion;

  const versionDefine = `--define:process.env.CLI_BUILD_VERSION=${JSON.stringify(cliVersion)}`;

  await rm(distDirectory, { recursive: true, force: true });
  await mkdir(distDirectory, { recursive: true });

  // Copy the @devcontainers/cli bundle into dist/ so that the shim can set
  // BOBODDY_DEVCONTAINER_SCRIPT pointing at it — matching the published layout
  // exactly. This means local dev builds behave identically to published ones.
  const devcontainerSrc = require.resolve(
    "@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js",
  );
  await copyFile(devcontainerSrc, resolve(distDirectory, "devcontainers-cli.js"));

  for (const target of allTargets) {
    process.stdout.write(`Building ${target.outputName}...\n`);
    await buildTarget(target, [versionDefine]);
  }

  if (isDev) {
    const artifactPath = process.env["BOBODDY_SDK_ARTIFACT_PATH"] ?? "";
    await writeFile(resolve(distDirectory, ".dev"), artifactPath, "utf8");
  }
}

await main();
