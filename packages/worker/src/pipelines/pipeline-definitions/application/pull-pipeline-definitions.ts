import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStepDefinitionsClient } from "@boboddy/sdk/definitions/steps";
import { generateStepsFileContent, type StepDefContract } from "../../../steps/step-definitions/infra/step-file-generator";
import { generatePipelineFileContent, type PipelineContract } from "../infra/pipeline-file-generator";
import {
  buildPipelineBuilderPackageJson,
  PIPELINE_BUILDER_GITIGNORE,
  PIPELINE_BUILDER_TSCONFIG,
} from "../infra/pipeline-builder-scaffolder";

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export interface PullPipelineDefinitionsOptions {
  projectId: string;
  baseUrl: string;
  headers: { Authorization: string };
  logger: Logger;
  dir: string;
  sdkVersion: string;
}

export interface PullPipelineDefinitionsResult {
  stepFiles: number;
  pipelineFiles: number;
}

async function fetchPipelines(
  baseUrl: string,
  projectId: string,
  headers: { Authorization: string },
): Promise<PipelineContract[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/linear-pipeline-definitions?projectId=${encodeURIComponent(projectId)}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const err = (await response.json().catch(() => null)) as { title?: string } | null;
    throw new Error(err?.title ?? `HTTP ${String(response.status)} GET /api/linear-pipeline-definitions`);
  }
  return response.json() as Promise<PipelineContract[]>;
}

function ensureScaffold(dir: string, sdkVersion: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const writeIfMissing = (relPath: string, content: string) => {
    const full = join(dir, relPath);
    if (!existsSync(full)) writeFileSync(full, content, "utf-8");
  };

  writeIfMissing("package.json", buildPipelineBuilderPackageJson(sdkVersion));
  writeIfMissing("tsconfig.json", PIPELINE_BUILDER_TSCONFIG);
  writeIfMissing(".gitignore", PIPELINE_BUILDER_GITIGNORE);
}

function resolveOutputFiles(dir: string, pipelineKeys: string[]): string[] {
  const files: string[] = [];
  if (existsSync(join(dir, "steps.ts"))) files.push("steps.ts");
  for (const key of pipelineKeys) {
    const name = `${key}.ts`;
    if (existsSync(join(dir, name))) files.push(name);
  }
  return files;
}

export async function pullPipelineDefinitions(
  options: PullPipelineDefinitionsOptions,
): Promise<PullPipelineDefinitionsResult> {
  const { projectId, baseUrl, headers, logger, dir, sdkVersion } = options;

  const stepDefsClient = createStepDefinitionsClient(baseUrl);
  const [rawSteps, pipelines] = await Promise.all([
    stepDefsClient.listByProjectId(projectId, { headers }),
    fetchPipelines(baseUrl, projectId, headers),
  ]);

  const stepDefs = rawSteps as StepDefContract[];

  if (stepDefs.length === 0 && pipelines.length === 0) {
    logger.info({}, "No pipeline or step definitions found for this project. Nothing to pull.");
    return { stepFiles: 0, pipelineFiles: 0 };
  }

  // Deduplicate steps: keep latest version per key
  const latestSteps = new Map<string, StepDefContract>();
  for (const step of stepDefs) {
    const existing = latestSteps.get(step.key);
    if (!existing || step.version > existing.version) latestSteps.set(step.key, step);
  }
  const dedupedSteps = [...latestSteps.values()];

  // Map stepDefinitionId → key for pipeline binding reconstruction
  const stepIdToKey = new Map<string, string>();
  for (const step of stepDefs) {
    stepIdToKey.set((step as unknown as { id: string }).id, step.key);
  }

  ensureScaffold(dir, sdkVersion);

  let pipelineFiles = 0;
  let stepFiles = 0;

  // Write steps.ts
  if (dedupedSteps.length > 0) {
    const content = generateStepsFileContent(dedupedSteps);
    writeFileSync(join(dir, "steps.ts"), content, "utf-8");
    logger.info({ file: "steps.ts" }, `✓ steps.ts (${String(dedupedSteps.length)} step${dedupedSteps.length !== 1 ? "s" : ""})`);
    stepFiles = 1;
  }

  // Write one file per pipeline
  for (const pipeline of pipelines) {
    const fileName = `${pipeline.key}.ts`;
    const content = generatePipelineFileContent(pipeline, stepIdToKey);
    writeFileSync(join(dir, fileName), content, "utf-8");
    logger.info({ file: fileName }, `✓ ${fileName}`);
    pipelineFiles++;
  }

  return { stepFiles, pipelineFiles };
}

export function getExistingOutputFiles(dir: string, pipelineKeys: string[]): string[] {
  return resolveOutputFiles(dir, pipelineKeys);
}

export function listExistingPipelineBuilderFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".ts"));
}
