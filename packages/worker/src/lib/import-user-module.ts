import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

type PackageJson = {
  exports?: string | Record<string, unknown>;
  main?: string;
};

const RELATIVE_USER_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const NODE_MODULES_SEGMENT = `${sep}node_modules${sep}`;

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("file:") &&
    !specifier.startsWith("node:") &&
    !specifier.startsWith("bun:");
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." ||
    specifier.startsWith("./") || specifier.startsWith("../");
}

function resolvePackageDirectory(specifier: string, importerPath: string): {
  packageDir: string;
  subpath: string;
} {
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@")
    ? `${segments[0]}/${segments[1] ?? ""}`
    : (segments[0] ?? "");
  const subpathSegments = specifier.startsWith("@") ? segments.slice(2) : segments.slice(1);
  let currentDir = dirname(importerPath);

  while (true) {
    const packageDir = join(currentDir, "node_modules", packageName);
    if (existsSync(packageDir)) {
      return { packageDir, subpath: subpathSegments.join("/") };
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Cannot find module '${specifier}' from '${importerPath}'`);
    }
    currentDir = parentDir;
  }
}

function resolveExportTarget(exportsField: PackageJson["exports"], subpath: string): string | null {
  if (!exportsField) {
    return null;
  }

  if (typeof exportsField === "string") {
    return subpath.length === 0 ? exportsField : null;
  }

  const key = subpath.length === 0 ? "." : `./${subpath}`;
  const entry = exportsField[key];
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    for (const condition of ["bun", "import", "default", "require"] as const) {
      const target = record[condition];
      if (typeof target === "string") {
        return target;
      }
    }
  }

  return null;
}

function resolveBareSpecifier(specifier: string, importerPath: string): string {
  // Normalize "node_modules/foo/..." → "foo/..." (IDE auto-import artifact)
  if (specifier.startsWith("node_modules/")) {
    specifier = specifier.slice("node_modules/".length);
  }

  const { packageDir, subpath } = resolvePackageDirectory(specifier, importerPath);
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  ) as PackageJson;
  let exportTarget = resolveExportTarget(packageJson.exports, subpath);

  // When the user imports via a dist/ path (e.g. from IDE auto-import), strip "dist/" and
  // walk up the subpath to find the containing package export.
  if (exportTarget === null && subpath.startsWith("dist/")) {
    let candidate = subpath.slice(5); // strip "dist/"
    while (candidate.length > 0 && exportTarget === null) {
      exportTarget = resolveExportTarget(packageJson.exports, candidate);
      const lastSlash = candidate.lastIndexOf("/");
      candidate = lastSlash > 0 ? candidate.slice(0, lastSlash) : "";
    }
  }

  const resolvedPath = exportTarget
    ? join(packageDir, exportTarget)
    : join(packageDir, packageJson.main ?? (subpath.length > 0 ? subpath : "index.js"));

  return pathToFileURL(resolvedPath).href;
}

function resolveRelativeUserModule(specifier: string, importerPath: string): string | null {
  const base = resolvePath(dirname(importerPath), specifier);
  const ext = extname(base);
  if (ext) {
    if (RELATIVE_USER_EXTENSIONS.includes(ext) && existsSync(base)) {
      return base;
    }
    return null;
  }
  for (const candidateExt of RELATIVE_USER_EXTENSIONS) {
    const candidate = base + candidateExt;
    if (existsSync(candidate)) return candidate;
  }
  for (const indexName of ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]) {
    const candidate = join(base, indexName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface PrepareContext {
  tempFiles: string[];
  cache: Map<string, string>; // original absolute path → URL to import
}

function preparePath(absPath: string, ctx: PrepareContext): string {
  const cached = ctx.cache.get(absPath);
  if (cached !== undefined) return cached;

  const ext = extname(absPath);
  const tempPath = join(
    dirname(absPath),
    `.${basename(absPath, ext)}.boboddy-load-${randomUUID()}${ext || ".js"}`,
  );
  const tempURL = pathToFileURL(tempPath).href;
  // Pre-cache the temp URL so cyclic re-entries get a stable reference.
  ctx.cache.set(absPath, tempURL);

  const source = readFileSync(absPath, "utf8");
  const { rewritten, changed } = rewriteImports(source, absPath, ctx);

  if (!changed) {
    const origURL = pathToFileURL(absPath).href;
    ctx.cache.set(absPath, origURL);
    return origURL;
  }

  writeFileSync(tempPath, rewritten, "utf8");
  ctx.tempFiles.push(tempPath);
  return tempURL;
}

function rewriteSpecifier(
  specifier: string,
  importerPath: string,
  ctx: PrepareContext,
): string {
  if (isBareSpecifier(specifier)) {
    let normalized = specifier;
    if (normalized.startsWith("node_modules/")) {
      normalized = normalized.slice("node_modules/".length);
    }
    return resolveBareSpecifier(normalized, importerPath);
  }
  if (isRelativeSpecifier(specifier)) {
    const resolved = resolveRelativeUserModule(specifier, importerPath);
    // Skip node_modules-resident files — those depend on their own package layout
    // and bun can resolve them natively.
    if (resolved !== null && !resolved.includes(NODE_MODULES_SEGMENT)) {
      const targetURL = preparePath(resolved, ctx);
      const origURL = pathToFileURL(resolved).href;
      // If the target needed no rewrites, leave the relative specifier intact.
      return targetURL === origURL ? specifier : targetURL;
    }
  }
  return specifier;
}

function rewriteImports(
  source: string,
  importerPath: string,
  ctx: PrepareContext,
): { rewritten: string; changed: boolean } {
  let changed = false;
  const applyRewrite = (quote: string, specifier: string, wrap: (s: string) => string): string => {
    const newSpec = rewriteSpecifier(specifier, importerPath, ctx);
    if (newSpec !== specifier) changed = true;
    return wrap(`${quote}${newSpec}${quote}`);
  };

  const rewritten = source
    .replace(/\bfrom\s+(['"])([^'"]+)\1/g, (_, quote: string, specifier: string) =>
      applyRewrite(quote, specifier, (s) => `from ${s}`),
    )
    .replace(/\bimport\s+(['"])([^'"]+)\1/g, (_, quote: string, specifier: string) =>
      applyRewrite(quote, specifier, (s) => `import ${s}`),
    )
    .replace(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g, (_, quote: string, specifier: string) =>
      applyRewrite(quote, specifier, (s) => `import(${s})`),
    );

  return { rewritten, changed };
}

export async function importUserModule(absPath: string): Promise<unknown> {
  const ctx: PrepareContext = { tempFiles: [], cache: new Map() };
  let targetURL: string;
  try {
    targetURL = preparePath(absPath, ctx);
  } catch (err) {
    for (const tmp of ctx.tempFiles) rmSync(tmp, { force: true });
    throw err;
  }

  try {
    return await import(targetURL);
  } finally {
    for (const tmp of ctx.tempFiles) rmSync(tmp, { force: true });
  }
}
