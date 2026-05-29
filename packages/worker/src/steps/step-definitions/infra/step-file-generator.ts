import { parseSchema } from "json-schema-to-zod";

export type StepDefContract = {
  key: string;
  name: string;
  description: string | null;
  prompt: string | null;
  version: number;
  status: string;
  inputSchemaJson: Record<string, unknown> | null;
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: Record<string, unknown> | null;
  signalExtractorDefinitions: Array<{
    key: string;
    sourcePath: string;
    type: string;
    required: boolean;
    availableWhenResultStatusIn: string[] | null;
  }>;
};

export function keyToVarName(key: string): string {
  return key
    .replace(/-([a-z])/g, (_, c: string) => (c as string).toUpperCase())
    .replace(/[^a-zA-Z0-9_$]/g, "_");
}

function schemaToZodExpr(schemaJson: Record<string, unknown> | null): string {
  if (!schemaJson) return "z.unknown()";
  try {
    return parseSchema(schemaJson as Parameters<typeof parseSchema>[0]);
  } catch {
    return "z.unknown()";
  }
}

function buildSignalLine(sig: StepDefContract["signalExtractorDefinitions"][number]): string {
  const parts: string[] = [`sourcePath: ${JSON.stringify(sig.sourcePath)}`];
  if (sig.key !== sig.sourcePath) parts.push(`key: ${JSON.stringify(sig.key)}`);
  parts.push(`type: ${JSON.stringify(sig.type)} as const`);
  if (!sig.required) parts.push("required: false");
  if (sig.availableWhenResultStatusIn !== null) {
    parts.push(`availableWhenResultStatusIn: ${JSON.stringify(sig.availableWhenResultStatusIn)}`);
  }
  return `    { ${parts.join(", ")} }`;
}

export function generateStepsFileContent(steps: StepDefContract[]): string {
  if (steps.length === 0) return "";

  const stepBlocks = steps.map((step) => {
    const varName = keyToVarName(step.key);
    const inputExpr = schemaToZodExpr(step.inputSchemaJson);
    const resultExpr = schemaToZodExpr(step.resultSchemaJson);
    const signalLines = step.signalExtractorDefinitions.map(buildSignalLine);

    const fields: string[] = [
      `  key: ${JSON.stringify(step.key)}`,
      `  name: ${JSON.stringify(step.name)}`,
      `  version: ${String(step.version)}`,
      `  status: ${JSON.stringify(step.status)} as const`,
    ];
    if (step.description) fields.push(`  description: ${JSON.stringify(step.description)}`);
    if (step.prompt) fields.push(`  prompt: ${JSON.stringify(step.prompt)}`);
    fields.push(`  input: ${inputExpr}`);
    fields.push(`  result: ${resultExpr}`);
    if (signalLines.length > 0) {
      fields.push(`  signals: [\n${signalLines.join(",\n")}\n  ]`);
    } else {
      fields.push("  signals: []");
    }
    if (step.opencodeMcpJson && Object.keys(step.opencodeMcpJson).length > 0) {
      const mcpJson = JSON.stringify(step.opencodeMcpJson, null, 2).replace(/\n/g, "\n  ");
      fields.push(`  mcpServers: ${mcpJson}`);
    }

    return `export const ${varName} = defineStep({\n${fields.join(",\n")},\n});`;
  });

  return `import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";

${stepBlocks.join("\n\n")}
`;
}
