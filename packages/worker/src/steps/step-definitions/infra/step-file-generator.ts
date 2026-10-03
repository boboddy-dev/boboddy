import { isDeepStrictEqual } from "node:util";
import { parseSchema } from "json-schema-to-zod";
import type { EnvVarSpec } from "@boboddy/sdk/env-vars";
import { resolveRepoConfig, type RepoConfig } from "@boboddy/sdk/repo-config";
import { isSecretLookingEnvName } from "@boboddy/sdk/definitions/steps";

export type StepDefContract = {
  key: string;
  name: string;
  description: string | null;
  prompt: string | null;
  version: number;
  status: string;
  executionMode: "workspace" | "no_workspace";
  devcontainerConfigPath: string | null;
  repo: RepoConfig;
  inputSchemaJson: Record<string, unknown> | null;
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: Record<string, unknown> | null;
  opencodePluginJson: unknown[] | null;
  healthChecksJson: unknown[] | null;
  envJson: EnvVarSpec[] | null;
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

const PROMPT_SCOPES = ["input", "env", "boboddy"] as const;
const REPO_MESSAGE_SCOPES = ["input", "result"] as const;

function scopedTokenPattern(scopes: readonly string[]): RegExp {
  return new RegExp(`\\{\\{(${scopes.join("|")})\\.([^}]+)\\}\\}`, "g");
}

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

/**
 * Renders a `{{scope.path}}` template as a JS expression: a plain literal when
 * it holds no token of the given scopes, otherwise a template literal with each
 * token turned into `${scope.path}`. Tokens of any other scope stay literal
 * text. Also reports which scopes the expression reads, so the caller can
 * destructure exactly those.
 */
function templateToExpr(
  prompt: string,
  scopes: readonly string[],
): { expr: string; usedScopes: string[] } {
  const matches = [...prompt.matchAll(scopedTokenPattern(scopes))];
  if (matches.length === 0) {
    return { expr: promptToLiteral(prompt), usedScopes: [] };
  }

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

  return {
    expr: `\`${template}\``,
    usedScopes: scopes.filter((scope) => usedScopes.has(scope)),
  };
}

export function promptToSource(prompt: string): string {
  const { expr, usedScopes } = templateToExpr(prompt, PROMPT_SCOPES);
  return usedScopes.length === 0
    ? expr
    : `({ ${usedScopes.join(", ")} }) => ${expr}`;
}

export function schemaToZodExpr(schemaJson: Record<string, unknown> | null): string {
  if (!schemaJson) return "z.unknown()";
  try {
    return parseSchema(schemaJson);
  } catch {
    return "z.unknown()";
  }
}

type EnvEntrySource = {
  expr: string;
  usesInput: boolean;
  usesEnvHelper: boolean;
};

/**
 * Renders one `envJson` entry the way `defineStep` accepts it back: a bare
 * string for a plain value, `Env.value` for a secret (or for a static value on
 * a secret-looking name, which `defineStep` would otherwise reject), and
 * `Env.inherit` for a worker-sourced variable with only its non-default
 * options spelled out.
 */
function envEntryToSource(entry: EnvVarSpec): EnvEntrySource {
  if (entry.source === "inherit") {
    const opts: string[] = [];
    if (entry.from !== entry.name) {
      opts.push(`from: ${JSON.stringify(entry.from)}`);
    }
    if (entry.secret) opts.push("secret: true");
    if (entry.optional) opts.push("optional: true");
    if (entry.default !== undefined) {
      opts.push(`default: ${JSON.stringify(entry.default)}`);
    }
    return {
      expr: `Env.inherit(${opts.length > 0 ? `{ ${opts.join(", ")} }` : ""})`,
      usesInput: false,
      usesEnvHelper: true,
    };
  }

  const { expr, usedScopes } = templateToExpr(entry.value, ["input"]);
  const usesInput = usedScopes.length > 0;
  if (entry.secret) {
    return {
      expr: `Env.value({ value: ${expr}, secret: true })`,
      usesInput,
      usesEnvHelper: true,
    };
  }
  if (!usesInput && isSecretLookingEnvName(entry.name)) {
    return {
      expr: `Env.value({ value: ${expr}, unsafeAllowStatic: true })`,
      usesInput,
      usesEnvHelper: true,
    };
  }
  return { expr, usesInput, usesEnvHelper: false };
}

/**
 * The `vars: ({ input }) => ({ ... })` property lines for a step's
 * `environment`, or null when it declares none. `input` is destructured only
 * when a template reads it.
 */
function buildVarsProperty(
  envJson: StepDefContract["envJson"],
): { property: string; usesEnvHelper: boolean } | null {
  if (!envJson || envJson.length === 0) return null;

  const entries = envJson.map((entry) => ({
    name: entry.name,
    ...envEntryToSource(entry),
  }));
  const params = entries.some((entry) => entry.usesInput) ? "{ input }" : "";
  const lines = entries.map(
    (entry) =>
      `      ${isValidIdentifier(entry.name) ? entry.name : JSON.stringify(entry.name)}: ${entry.expr},`,
  );
  return {
    property: `    vars: (${params}) => ({\n${lines.join("\n")}\n    }),`,
    usesEnvHelper: entries.some((entry) => entry.usesEnvHelper),
  };
}

/**
 * The runtime property for a step's `environment`, or null for the default
 * (a workspace step with no selected config). `no_workspace` is the host
 * runtime, which carries no config path.
 */
function buildRuntimeProperty(step: StepDefContract): string | null {
  if (step.executionMode === "no_workspace") {
    return "    runtime: Runtime.host(),";
  }
  if (step.devcontainerConfigPath) {
    return `    runtime: Runtime.devcontainer({ config: ${JSON.stringify(step.devcontainerConfigPath)} }),`;
  }
  return null;
}

/**
 * The `repo` property lines for a step's `environment`, or null when the
 * resolved config is its runtime's default. `Repo.readWrite` takes the function
 * form only when the message reads `input` or `result`, destructuring exactly
 * the proxies it uses.
 */
function buildRepoProperty(step: StepDefContract): string | null {
  const { repo } = step;
  if (isDeepStrictEqual(repo, resolveRepoConfig(step.executionMode))) {
    return null;
  }
  if (repo.mode !== "readWrite") return `    repo: Repo.${repo.mode}(),`;

  const opts: string[] = [];
  let params = "";
  if (repo.message !== null) {
    const { expr, usedScopes } = templateToExpr(
      repo.message,
      REPO_MESSAGE_SCOPES,
    );
    opts.push(`message: ${expr}`);
    if (usedScopes.length > 0) params = `{ ${usedScopes.join(", ")} }`;
  }
  if (repo.onPushFailure !== "fail") {
    opts.push(`onPushFailure: ${JSON.stringify(repo.onPushFailure)}`);
  }
  const call = `Repo.readWrite(${opts.length > 0 ? `{ ${opts.join(", ")} }` : ""})`;
  return params === ""
    ? `    repo: ${call},`
    : `    repo: (${params}) => ${call},`;
}

type EnvironmentField = {
  field: string;
  usesEnvHelper: boolean;
  usesRuntimeHelper: boolean;
  usesRepoHelper: boolean;
};

/**
 * The `environment: { runtime, vars, repo }` field for a step, or null when it
 * declares none. It precedes `agentPrompt` so `vars` keys are inferred into
 * the prompt's `env`.
 */
function buildEnvironmentField(step: StepDefContract): EnvironmentField | null {
  const runtime = buildRuntimeProperty(step);
  const vars = buildVarsProperty(step.envJson);
  const repo = buildRepoProperty(step);
  const properties = [runtime, vars?.property, repo].filter(
    (property): property is string =>
      property !== null && property !== undefined,
  );
  if (properties.length === 0) return null;

  return {
    field: `  environment: {\n${properties.join("\n")}\n  }`,
    usesEnvHelper: vars?.usesEnvHelper ?? false,
    usesRuntimeHelper: runtime !== null,
    usesRepoHelper: repo !== null,
  };
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

  const environmentFields = steps.map(buildEnvironmentField);
  const usesEnvHelper = environmentFields.some((field) => field?.usesEnvHelper);
  const usesRuntimeHelper = environmentFields.some(
    (field) => field?.usesRuntimeHelper,
  );
  const usesRepoHelper = environmentFields.some(
    (field) => field?.usesRepoHelper,
  );
  const stepBlocks = steps.map((step, index) => {
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
    const environmentField = environmentFields[index];
    if (environmentField) fields.push(environmentField.field);
    fields.push(`  agentPrompt: ${promptToSource(step.prompt ?? "")}`);
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

  const sdkImports = [
    "defineStep",
    ...(usesRuntimeHelper ? ["Runtime"] : []),
    ...(usesRepoHelper ? ["Repo"] : []),
    ...(usesEnvHelper ? ["Env"] : []),
  ].join(", ");
  return `import { z } from "zod";
import { ${sdkImports} } from "@boboddy/sdk/definitions/steps";

${stepBlocks.join("\n\n")}
`;
}
