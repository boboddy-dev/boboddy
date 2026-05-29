import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PIPELINE_BUILDER_DIR = ".boboddy/pipeline-builder";

export type StepSignalInfo = {
  key: string;
  sourcePath: string;
  type: string;
};

export type StepInfo = {
  key: string;
  name: string;
  version: number;
  prompt?: string | null;
  signals: StepSignalInfo[];
};

type ScaffoldResult = {
  created: string[];
  skipped: string[];
};

function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function resolveSdkDependency(sdkVersion: string): string {
  const artifactPath = process.env["BOBODDY_SDK_ARTIFACT_PATH"];
  if (artifactPath) {
    return `file:${artifactPath}`;
  }

  return `^${sdkVersion}`;
}

export function buildPipelineBuilderPackageJson(sdkVersion: string): string {
  return JSON.stringify(
    {
      name: "pipeline-builder",
      private: true,
      type: "module",
      dependencies: {
        "@boboddy/sdk": resolveSdkDependency(sdkVersion),
        zod: "^4.4.2",
      },
      // tsx lets `boboddy pipelines push` execute `push.ts` under node-based
      // package managers (npm/pnpm/yarn). bun and deno don't need it.
      devDependencies: {
        tsx: "^4.20.0",
      },
    },
    null,
    2,
  );
}

export const PIPELINE_BUILDER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "ESNext",
      moduleResolution: "Bundler",
      moduleDetection: "force",
      verbatimModuleSyntax: true,
      resolveJsonModule: true,
      strict: true,
      isolatedModules: true,
      baseUrl: ".",
    },
    include: ["**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
);

export const PIPELINE_BUILDER_GITIGNORE = `*
`;

function zodType(type: string): string {
  switch (type) {
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "array":
      return "z.array(z.unknown())";
    case "object":
      return "z.record(z.string(), z.unknown())";
    default:
      return "z.string()";
  }
}

function buildResultSchema(signals: StepSignalInfo[]): string {
  const topLevel = signals.filter((s) => !s.sourcePath.includes("."));
  if (topLevel.length === 0) return "z.object({})";
  const fields = topLevel
    .map((s) => `    ${s.sourcePath}: ${zodType(s.type)},`)
    .join("\n");
  return `z.object({
${fields}
  })`;
}

function buildCombinedFile(steps: StepInfo[]): string {
  const inputSchemaDecl = `const inputSchema = z.object({
  content: z.string(),
});`;

  if (steps.length === 0) {
    return `import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";
import { pipeline } from "@boboddy/sdk/definitions/pipelines";

${inputSchemaDecl}

const placeholderStep = defineStep({
  key: "placeholder",
  name: "Placeholder",
  version: 1,
  input: z.object({
    content: z.string(),
  }),
  result: z.object({}),
  signals: [],
});

export default pipeline({
  key: "investigation",
  name: "Investigation",
  input: inputSchema,
})
  .step(placeholderStep, ({ input }) => ({ content: input.content }))
  .advance(() => ({ default: "continue" }))
  .build();
`;
  }

  const stepDefs = steps
    .map((step) => {
      const signalLines = step.signals
        .map(
          (s) =>
            `    { key: ${JSON.stringify(s.key)}, sourcePath: ${JSON.stringify(s.sourcePath)} },`,
        )
        .join("\n");
      const signalsSection =
        step.signals.length > 0
          ? `  signals: [
${signalLines}
  ],
`
          : `  signals: [],
`;

      const promptLine = step.prompt
        ? `  prompt: ${JSON.stringify(step.prompt)},
`
        : "";

      return `export const ${kebabToCamel(step.key)} = defineStep({
  key: ${JSON.stringify(step.key)},
  name: ${JSON.stringify(step.name)},
  version: ${String(step.version)},
${promptLine}  input: z.object({
    content: z.string(),
  }),
  result: ${buildResultSchema(step.signals)},
  mcpServers: {
    postgres: {
      type: "local",
      command: ["uvx", "postgres-mcp", "--access-mode=unrestricted"],
      environment: {
        DATABASE_URI: "{env:DATABASE_URI}",
      },
    },
  },
${signalsSection}});`;
    })
    .join("\n\n");

  const stepChain = steps
    .map((step, index) => {
      const stepVar = kebabToCamel(step.key);
      const isFirst = index === 0;
      const firstSignal = step.signals[0];
      const mapper = isFirst
        ? `({ input }) => ({ content: input.content })`
        : `() => ({})`;
      const stepCall = `  .step(${stepVar}, ${mapper})`;

      if (firstSignal) {
        return `${stepCall}
  .advance(({ signal }) => ({
    default: "block",
    rules: [signal(${JSON.stringify(firstSignal.key)}).gte(1).then("continue")],
  }))`;
      }
      return `${stepCall}
  .advance(() => ({ default: "continue" }))`;
    })
    .join("\n");

  return `import { z } from "zod";
import { defineStep } from "@boboddy/sdk/definitions/steps";
import { pipeline } from "@boboddy/sdk/definitions/pipelines";

${inputSchemaDecl}

${stepDefs}

export default pipeline({
  key: "investigation",
  name: "Investigation",
  input: inputSchema,
})
${stepChain}
  .build();
`;
}

export function scaffoldPipelineBuilderDirectory(
  dir: string,
  steps: StepInfo[],
  sdkVersion: string,
): ScaffoldResult {
  const result: ScaffoldResult = { created: [], skipped: [] };

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  function writeFile(relPath: string, content: string): void {
    const filePath = join(dir, relPath);
    if (existsSync(filePath)) {
      result.skipped.push(relPath);
    } else {
      writeFileSync(filePath, content, "utf-8");
      result.created.push(relPath);
    }
  }

  writeFile("package.json", buildPipelineBuilderPackageJson(sdkVersion));
  writeFile("tsconfig.json", PIPELINE_BUILDER_TSCONFIG);
  writeFile(".gitignore", PIPELINE_BUILDER_GITIGNORE);
  writeFile("example-pipeline.ts", buildCombinedFile(steps));

  return result;
}
