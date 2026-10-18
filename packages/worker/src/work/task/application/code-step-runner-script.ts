/**
 * The runner script `execute-code-step.ts` writes next to a code step's module
 * and executes inside the workspace. Written as a standalone `.mjs` so it
 * works verbatim under either `bun` or `node`'s ESM loader. Prefers `bun` when
 * present because code-step modules are typically authored in TypeScript (the
 * same `.boboddy/pipeline-builder/*.ts` files `@boboddy/sdk` collects them
 * from) and `bun`'s `import()` handles `.ts` natively; a devcontainer that only
 * has plain `node` (no TS loader) surfaces a clear import error for a `.ts`
 * module.
 *
 * The script imports the module, then asks `@boboddy/sdk/code-step-lookup`
 * (the same discovery the push-time collector uses) for the code step with the
 * given key, so the step may be exported by name or embedded in the module's
 * default-exported pipeline. It must live beside the user's module so that the
 * bare `@boboddy/sdk/code-step-lookup` import resolves by walking up from the
 * same directory as the module's own imports do.
 *
 * argv: `<entrypointAbsPath> <stepKey> <inputFileAbsPath> <findingsFileAbsPath>`.
 * Every failure is an exit code of 1 with a message on stderr.
 */
export const CODE_STEP_RUNNER_SCRIPT_SOURCE = `
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function describeError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function readInstalledSdkVersion() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const raw = await readFile(
        path.join(dir, "node_modules", "@boboddy", "sdk", "package.json"),
        "utf8",
      );
      const version = JSON.parse(raw).version;
      return typeof version === "string" ? version : "unknown";
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return "not installed";
      dir = parent;
    }
  }
}

async function main() {
  const [, , entrypointPath, stepKey, inputFilePath, findingsFilePath] = process.argv;
  if (!entrypointPath || !stepKey || !inputFilePath || !findingsFilePath) {
    console.error("boboddy code-step runner: missing required arguments");
    process.exitCode = 1;
    return;
  }

  let inputJson;
  try {
    const rawInput = await readFile(inputFilePath, "utf8");
    inputJson = JSON.parse(rawInput);
  } catch (error) {
    console.error(
      \`boboddy code-step runner: failed to read/parse input file at \${inputFilePath}: \${
        error instanceof Error ? error.message : String(error)
      }\`,
    );
    process.exitCode = 1;
    return;
  }

  let mod;
  try {
    mod = await import(entrypointPath);
  } catch (error) {
    console.error(
      \`boboddy code-step runner: failed to import entrypoint module at \${entrypointPath}: \${describeError(error)}\`,
    );
    process.exitCode = 1;
    return;
  }

  let findCodeStepInModule;
  try {
    ({ findCodeStepInModule } = await import("@boboddy/sdk/code-step-lookup"));
  } catch (error) {
    console.error(
      \`boboddy code-step runner: the installed @boboddy/sdk is too old for inline code steps; upgrade it (installed version: \${
        await readInstalledSdkVersion()
      }; \${error instanceof Error ? error.message : String(error)})\`,
    );
    process.exitCode = 1;
    return;
  }
  if (typeof findCodeStepInModule !== "function") {
    console.error(
      \`boboddy code-step runner: the installed @boboddy/sdk is too old for inline code steps; upgrade it (installed version: \${
        await readInstalledSdkVersion()
      })\`,
    );
    process.exitCode = 1;
    return;
  }

  let fn;
  try {
    fn = findCodeStepInModule(mod, stepKey);
  } catch (error) {
    console.error(
      \`boboddy code-step runner: \${error instanceof Error ? error.message : String(error)}\`,
    );
    process.exitCode = 1;
    return;
  }
  if (typeof fn !== "function") {
    console.error(
      \`boboddy code-step runner: no code step with key "\${stepKey}" exported by or embedded in \${entrypointPath}\`,
    );
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await fn(inputJson);
  } catch (error) {
    console.error(
      \`boboddy code-step runner: code step "\${stepKey}" threw: \${describeError(error)}\`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await writeFile(
      findingsFilePath,
      \`\${JSON.stringify({ findingsJson: result === undefined ? null : result }, null, 2)}\\n\`,
      "utf8",
    );
  } catch (error) {
    console.error(
      \`boboddy code-step runner: failed to write findings submission to \${findingsFilePath}: \${
        error instanceof Error ? error.message : String(error)
      }\`,
    );
    process.exitCode = 1;
  }
}

await main();
`;
