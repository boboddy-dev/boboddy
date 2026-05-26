import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { StepDefinitionSpec } from "@boboddy/sdk/definitions/steps";

function isStepDefinitionSpec(value: unknown): value is StepDefinitionSpec {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["key"] === "string" &&
    typeof obj["name"] === "string" &&
    typeof obj["version"] === "number" &&
    obj["kind"] === "user_defined"
  );
}

function isMissingDepError(message: string): boolean {
  return (
    message.includes("Cannot find module") || message.includes("Cannot find package")
  );
}

// Requires the bun runtime: see load-pipelines-from-directory.ts for details.
export async function loadStepsFromDirectory(
  dir: string,
): Promise<StepDefinitionSpec[]> {
  const absDir = resolve(dir);
  const entries = readdirSync(absDir);
  const stepFiles = entries.filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js"),
  );

  if (stepFiles.length === 0) {
    return [];
  }

  const specs: StepDefinitionSpec[] = [];

  for (const file of stepFiles) {
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

    if (!isStepDefinitionSpec(spec)) {
      throw new Error(
        `${file}: default export is not a valid StepDefinitionSpec. ` +
          `Make sure to export the result of defineStep() as the default export.`,
      );
    }

    specs.push(spec);
  }

  return specs;
}
