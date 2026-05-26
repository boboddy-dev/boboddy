import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PipelineDefinitionSpec } from "@boboddy/sdk/definitions/pipelines";

function isPipelineDefinitionSpec(value: unknown): value is PipelineDefinitionSpec {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["key"] === "string" &&
    typeof obj["name"] === "string" &&
    typeof obj["version"] === "number" &&
    Array.isArray(obj["steps"])
  );
}

function isMissingDepError(message: string): boolean {
  return (
    message.includes("Cannot find module") || message.includes("Cannot find package")
  );
}

// Requires the bun runtime: dynamic `await import(...)` of user TS files and bare-specifier
// resolution against the user's `node_modules/` rely on bun's native behavior, which is
// preserved even in `bun build --compile` binaries.
export async function loadPipelinesFromDirectory(
  dir: string,
): Promise<PipelineDefinitionSpec[]> {
  const absDir = resolve(dir);
  const entries = readdirSync(absDir);
  const sourceFiles = entries.filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js"),
  );

  if (sourceFiles.length === 0) {
    return [];
  }

  const specs: PipelineDefinitionSpec[] = [];

  for (const file of sourceFiles) {
    const absPath = join(absDir, file);
    let imported: unknown;
    try {
      imported = await import(pathToFileURL(absPath).href);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMissingDepError(message)) {
        throw new Error(
          `Failed to import ${file}: ${message}\n\nRun \`npm install\` or \`bun install\` inside .boboddy/pipeline-builder/ to install dependencies first.`,
          { cause: err },
        );
      }
      throw err;
    }
    const mod = imported as { default: unknown };
    const spec = mod.default;

    if (!isPipelineDefinitionSpec(spec)) {
      continue;
    }

    specs.push(spec);
  }

  return specs;
}
