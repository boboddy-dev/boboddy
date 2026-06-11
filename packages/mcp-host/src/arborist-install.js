/**
 * Installs dependencies from `.opencode/package.json` using arborist.
 *
 * Spawned as a Node.js subprocess (node --input-type=module) by the MCP host.
 * Input is embedded by runNodeScriptWithInput via the readFileSync sentinel.
 * Stdout: JSON { ok: true } or { error: string }
 *
 * Arborist is loaded from npm's own bundled node_modules, which are always
 * co-located with the node executable at:
 *   <node-prefix>/lib/node_modules/npm/node_modules/@npmcli/arborist
 *
 * This avoids depending on npm being on PATH or arborist being installed
 * globally, and avoids bundling arborist into the Bun binary (which breaks
 * due to node-gyp path baking at compile time).
 */

import { createRequire } from "module";
import path from "path";
import { readFileSync } from "fs";

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { opencodeDir } = input;

// Locate arborist inside npm's own bundled node_modules, relative to the
// node executable. npm is always installed alongside node and always bundles
// arborist internally.
const nodeDir = path.dirname(process.execPath);
const arboristPath = path.resolve(
  nodeDir,
  "../lib/node_modules/npm/node_modules/@npmcli/arborist",
);
const req = createRequire(import.meta.url);

let Arborist;
try {
  Arborist = req(arboristPath);
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      error: "Could not load arborist from npm bundle: " + e.message,
    }) + "\n",
  );
  process.exit(0);
}

try {
  const arborist = new Arborist({
    path: opencodeDir,
    binLinks: true,
    progress: false,
    savePrefix: "",
    ignoreScripts: true,
  });
  await arborist.reify();
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
} catch (err) {
  process.stdout.write(
    JSON.stringify({ error: err?.message ?? String(err) }) + "\n",
  );
}
