import { parseSchema } from "json-schema-to-zod";

export type StepDefContract = {
  key: string;
  name: string;
  description: string | null;
  prompt: string | null;
  version: number;
  status: string;
  executionMode: "workspace" | "no_workspace";
  inputSchemaJson: Record<string, unknown> | null;
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: Record<string, unknown> | null;
  opencodePluginJson: unknown[] | null;
  healthChecksJson: unknown[] | null;
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
    .replace(/-([a-z])/g, (_, c: string) => (c).toUpperCase())
    .replace(/[^a-zA-Z0-9_$]/g, "_");
}

export function promptToLiteral(prompt: string): string {
  if (!prompt.includes("\n")) return JSON.stringify(prompt);
  const escaped = prompt
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `\`${escaped}\``;
}

const SCOPED_PROMPT_TOKEN = /\{\{(input|env|boboddy)\.([^}]+)\}\}/g;

function isValidIdentifier(part: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(part);
}

function promptPathToJsExpr(scope: string, path: string): string {
  return path
    .split(".")
    .filter((part) => part.length > 0)
    .reduce(
      (expr, part) =>
        isValidIdentifier(part)
          ? `${expr}.${part}`
          : `${expr}[${JSON.stringify(part)}]`,
      scope,
    );
}

export function promptToSource(prompt: string): string {
  const matches = [...prompt.matchAll(SCOPED_PROMPT_TOKEN)];
  if (matches.length === 0) return promptToLiteral(prompt);

  const usedScopes = new Set(matches.map((match) => match[1]));
  const placeholders = matches.map((match, index) => ({
    token: match[0],
    marker: `__BOBODDY_PROMPT_EXPR_${String(index)}__`,
    expr: `\${${promptPathToJsExpr(match[1] ?? "", match[2] ?? "")}}`,
  }));

  let template = prompt;
  for (const placeholder of placeholders) {
    template = template.replace(placeholder.token, placeholder.marker);
  }

  template = template
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");

  for (const placeholder of placeholders) {
    template = template.replaceAll(placeholder.marker, placeholder.expr);
  }

  const destructuredScopes = ["input", "env", "boboddy"].filter((scope) =>
    usedScopes.has(scope),
  );
  return `({ ${destructuredScopes.join(", ")} }) => \`${template}\``;
}

export function schemaToZodExpr(schemaJson: Record<string, unknown> | null): string {
  if (!schemaJson) return "z.unknown()";
  try {
    return parseSchema(schemaJson);
  } catch {
    return "z.unknown()";
  }
}

function buildSignalLine(
  sig: StepDefContract["signalExtractorDefinitions"][number],
): string {
  const parts: string[] = [`sourcePath: ${JSON.stringify(sig.sourcePath)}`];
  if (sig.key !== sig.sourcePath) parts.push(`key: ${JSON.stringify(sig.key)}`);
  parts.push(`type: ${JSON.stringify(sig.type)} as const`);
  if (!sig.required) parts.push("required: false");
  if (sig.availableWhenResultStatusIn !== null) {
    parts.push(
      `availableWhenResultStatusIn: ${JSON.stringify(sig.availableWhenResultStatusIn)}`,
    );
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
    if (step.description)
      fields.push(`  description: ${JSON.stringify(step.description)}`);
    fields.push(`  agentPrompt: ${promptToSource(step.prompt ?? "")}`);
    if (step.executionMode === "no_workspace") {
      fields.push(`  executionMode: "no_workspace"`);
    }
    fields.push(`  input: ${inputExpr}`);
    fields.push(`  result: ${resultExpr}`);
    if (signalLines.length > 0) {
      fields.push(`  signals: [\n${signalLines.join(",\n")}\n  ]`);
    } else {
      fields.push("  signals: []");
    }
    if (step.opencodeMcpJson && Object.keys(step.opencodeMcpJson).length > 0) {
      const mcpJson = JSON.stringify(step.opencodeMcpJson, null, 2).replace(
        /\n/g,
        "\n  ",
      );
      fields.push(`  mcpServers: ${mcpJson}`);
    }
    if (step.opencodePluginJson && step.opencodePluginJson.length > 0) {
      const pluginJson = JSON.stringify(
        step.opencodePluginJson,
        null,
        2,
      ).replace(/\n/g, "\n  ");
      fields.push(`  plugins: ${pluginJson}`);
    }
    if (step.healthChecksJson && step.healthChecksJson.length > 0) {
      const healthChecksJson = JSON.stringify(
        step.healthChecksJson,
        null,
        2,
      ).replace(/\n/g, "\n  ");
      fields.push(`  healthChecks: ${healthChecksJson}`);
    }

    return `export const ${varName} = defineStep({\n${fields.join(",\n")},\n});`;
  });

  return `import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";

${stepBlocks.join("\n\n")}
`;
}
