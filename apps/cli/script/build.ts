import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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

  // Copy the @devcontainers/cli bundle and its companion assets into dist/.
  //
  // The bundle resolves sibling assets (notably scripts/updateUID.Dockerfile,
  // which it uses on Linux when remapping the container user's UID/GID) via:
  //
  //   extensionPath = join(__dirname, "..", "..")
  //
  // where __dirname is the directory containing the bundle. In the upstream
  // package the bundle lives at <root>/dist/spec-node/devContainersSpecCLI.js,
  // so extensionPath resolves to <root>/ and the Dockerfile is found at
  // <root>/scripts/updateUID.Dockerfile.
  //
  // To keep every generated asset self-contained under our own dist/ (rather
  // than leaking a scripts/ dir into the package root / apps/cli/scripts), we
  // nest the bundle one level deeper so extensionPath stays inside dist/:
  //
  //   dist/devcontainer/dist/spec-node/devcontainers-cli.js  ← bundle
  //       __dirname        = dist/devcontainer/dist/spec-node/
  //       extensionPath    = dist/devcontainer/        (join(__dirname,"..",".."))
  //   dist/devcontainer/scripts/updateUID.Dockerfile         ← resolved asset
  //
  // BOBODDY_DEVCONTAINER_SCRIPT (set by publish.ts and the dev shim) points at
  // the nested dist/devcontainer/dist/spec-node/devcontainers-cli.js path.
  const devcontainerSrc = require.resolve(
    "@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js",
  );
  const devcontainerDest = resolve(
    distDirectory,
    "devcontainer",
    "dist",
    "spec-node",
    "devcontainers-cli.js",
  );
  await mkdir(dirname(devcontainerDest), { recursive: true });
  await copyFile(devcontainerSrc, devcontainerDest);

  const updateUIDSrc = require.resolve(
    "@devcontainers/cli/scripts/updateUID.Dockerfile",
  );
  const updateUIDDest = resolve(
    distDirectory,
    "devcontainer",
    "scripts",
    "updateUID.Dockerfile",
  );
  await mkdir(dirname(updateUIDDest), { recursive: true });
  await copyFile(updateUIDSrc, updateUIDDest);

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
