// Produces the static assets `@boboddy/worker`'s local studio server reads
// from disk (see `run-pipeline-studio-server.ts`): `dist/index.html` and
// `dist/main.js`.
//
// Uses Bun's own bundler rather than introducing Vite/webpack/esbuild — the
// repo has no existing convention for a standalone (non-Next, non-Astro)
// browser app, and the plan itself frames this feature around "Bun's native
// APIs, consistent with the rest of the Bun-workspace stack" (see the plan
// doc's §10, re: `Bun.serve`). `Bun.build` picks up this package's own
// `tsconfig.json` (`"jsx": "react-jsx"`) for the JSX transform.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STUDIO_INDEX_HTML } from "./src/index-html-template";

const packageDir = import.meta.dir;
const outdir = join(packageDir, "dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(packageDir, "src/main.tsx")],
  outdir,
  target: "browser",
  format: "esm",
  naming: "[name].[ext]",
  minify: process.env["NODE_ENV"] === "production",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("pipeline-studio-ui build failed");
}

writeFileSync(join(outdir, "index.html"), STUDIO_INDEX_HTML, "utf8");

console.warn(`[pipeline-studio-ui] built ${String(result.outputs.length)} file(s) into ${outdir}`);
