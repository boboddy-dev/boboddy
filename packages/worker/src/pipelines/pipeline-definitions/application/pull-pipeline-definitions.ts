import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createStepDefinitionsClient } from "@boboddy/sdk/definitions/steps";
import {
  createPipelineDefinitionsClient,
  DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
} from "@boboddy/sdk/definitions/pipelines";
import { createBoboddyClient } from "@boboddy/sdk/client";
import {
  generateStepsFileContent,
  type StepDefContract,
} from "../../../steps/step-definitions/infra/step-file-generator";
import {
  generatePipelineFileContent,
  type PipelineContract,
} from "../infra/pipeline-file-generator";
import {
  generateDefaultPipelineAssignmentFileContent,
  UnsupportedRuleError,
  type DefaultPipelineAssignmentContract,
} from "../infra/default-pipeline-assignment-file-generator";
import {
  generateWorkItemFieldsFileContent,
  type WorkItemFieldOption,
} from "../infra/work-item-fields-file-generator";
import {
  buildPipelineBuilderPackageJson,
  PIPELINE_BUILDER_GITIGNORE,
  PIPELINE_BUILDER_TSCONFIG,
} from "../infra/pipeline-builder-scaffolder";

type Logger = {
  // eslint-disable-next-line local/no-unknown-parameter-type
  info: (obj: unknown, msg?: string) => void;
  // eslint-disable-next-line local/no-unknown-parameter-type
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
  /** true if default-pipeline-assignment.ts was written. */
  defaultPipelineAssignmentFile: boolean;
  /** true if work-item-fields.ts was written. */
  workItemFieldsFile: boolean;
}

export const WORK_ITEM_FIELDS_FILENAME = "work-item-fields.ts";

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
  if (existsSync(join(dir, DEFAULT_PIPELINE_ASSIGNMENT_FILENAME))) {
    files.push(DEFAULT_PIPELINE_ASSIGNMENT_FILENAME);
  }
  if (existsSync(join(dir, WORK_ITEM_FIELDS_FILENAME))) {
    files.push(WORK_ITEM_FIELDS_FILENAME);
  }
  return files;
}

export async function pullPipelineDefinitions(
  options: PullPipelineDefinitionsOptions,
): Promise<PullPipelineDefinitionsResult> {
  const { projectId, baseUrl, headers, logger, dir, sdkVersion } = options;

  const stepDefsClient = createStepDefinitionsClient(baseUrl);
  const pipelineDefsClient = createPipelineDefinitionsClient(baseUrl);
  const boboddyClient = createBoboddyClient(baseUrl);

  const [rawSteps, pipelines, projectResult, fieldOptionsResult] =
    (await Promise.all([
      stepDefsClient.listByProjectId(projectId, { headers }),
      pipelineDefsClient.listByProjectId(projectId, { headers }),
      boboddyClient.projects.getProject({ path: { projectId }, headers }),
      boboddyClient.projects.listProjectWorkItemFieldOptions({
        path: { projectId },
        headers,
      }),
    ])) as unknown as [
      StepDefContract[],
      PipelineContract[],
      { data?: { defaultPipelineAssignment?: unknown }; error?: unknown },
      { data?: WorkItemFieldOption[]; error?: unknown },
    ];

  const stepDefs = rawSteps;

  if (stepDefs.length === 0 && pipelines.length === 0) {
    logger.info(
      {},
      "No pipeline or step definitions found for this project. Nothing to pull.",
    );
    return {
      stepFiles: 0,
      pipelineFiles: 0,
      defaultPipelineAssignmentFile: false,
      workItemFieldsFile: false,
    };
  }

  // Deduplicate steps: keep latest version per key
  const latestSteps = new Map<string, StepDefContract>();
  for (const step of stepDefs) {
    const existing = latestSteps.get(step.key);
    if (!existing || step.version > existing.version)
      latestSteps.set(step.key, step);
  }
  const dedupedSteps = [...latestSteps.values()];

  // Map stepDefinitionId → key for pipeline binding reconstruction
  const stepIdToKey = new Map<string, string>();
  for (const step of stepDefs) {
    stepIdToKey.set((step as unknown as { id: string }).id, step.key);
  }

  // Map pipelineDefinitionId → pipeline key for assignment reconstruction
  const pipelineIdToKey = new Map<string, string>();
  for (const pipeline of pipelines) {
    const pipelineWithId = pipeline as unknown as { id: string; key: string };
    if (pipelineWithId.id) {
      pipelineIdToKey.set(pipelineWithId.id, pipeline.key);
    }
  }

  ensureScaffold(dir, sdkVersion);

  let pipelineFiles = 0;
  let stepFiles = 0;

  // Write steps.ts
  if (dedupedSteps.length > 0) {
    const content = generateStepsFileContent(dedupedSteps);
    writeFileSync(join(dir, "steps.ts"), content, "utf-8");
    logger.info(
      { file: "steps.ts" },
      `✓ steps.ts (${String(dedupedSteps.length)} step${dedupedSteps.length !== 1 ? "s" : ""})`,
    );
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

  // Handle default pipeline assignment
  let defaultPipelineAssignmentFile = false;
  const assignmentFilePath = join(dir, DEFAULT_PIPELINE_ASSIGNMENT_FILENAME);

  const project = (
    projectResult as { data?: { defaultPipelineAssignment?: unknown } }
  ).data;
  const rawAssignment = project?.defaultPipelineAssignment;

  const assignment = isDefaultPipelineAssignmentContract(rawAssignment)
    ? rawAssignment
    : null;

  if (assignment) {
    try {
      const content = generateDefaultPipelineAssignmentFileContent(
        assignment,
        pipelineIdToKey,
      );
      writeFileSync(assignmentFilePath, content, "utf-8");
      logger.info(
        { file: DEFAULT_PIPELINE_ASSIGNMENT_FILENAME },
        `✓ ${DEFAULT_PIPELINE_ASSIGNMENT_FILENAME}`,
      );
      defaultPipelineAssignmentFile = true;
    } catch (err) {
      if (err instanceof UnsupportedRuleError) {
        throw new Error(
          `Project default pipeline assignment contains rules that cannot be rendered ` +
            `with the fluent SDK: ${err.message}\n` +
            `Re-author the policy with the SDK and push again.`,
          { cause: err },
        );
      }
      throw err;
    }
  } else {
    // No server assignment — remove the generated reserved file if it exists
    if (existsSync(assignmentFilePath)) {
      unlinkSync(assignmentFilePath);
      logger.info(
        { file: DEFAULT_PIPELINE_ASSIGNMENT_FILENAME },
        `Removed ${DEFAULT_PIPELINE_ASSIGNMENT_FILENAME} (no server assignment configured).`,
      );
    }
  }

  // Write work-item-fields.ts: a per-project WorkItemFieldName snapshot for
  // typed workItem.field<WorkItemFieldName>(...) usage. Always written (even
  // when the project has no observed fields yet, as `never`) so its
  // presence never depends on project state.
  const fieldOptions = fieldOptionsResult.data ?? [];
  const workItemFieldsContent = generateWorkItemFieldsFileContent(fieldOptions);
  writeFileSync(
    join(dir, WORK_ITEM_FIELDS_FILENAME),
    workItemFieldsContent,
    "utf-8",
  );
  logger.info(
    { file: WORK_ITEM_FIELDS_FILENAME },
    `✓ ${WORK_ITEM_FIELDS_FILENAME} (${String(fieldOptions.length)} field${fieldOptions.length !== 1 ? "s" : ""})`,
  );

  return {
    stepFiles,
    pipelineFiles,
    defaultPipelineAssignmentFile,
    workItemFieldsFile: true,
  };
}

function isDefaultPipelineAssignmentContract(
  // eslint-disable-next-line local/no-unknown-parameter-type
  value: unknown,
): value is DefaultPipelineAssignmentContract {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["pipelineDefinitionId"] === "string" &&
    typeof obj["rulesJson"] === "object" &&
    obj["rulesJson"] !== null &&
    (obj["defaultEventType"] === "assign" ||
      obj["defaultEventType"] === "skip") &&
    Array.isArray(obj["allowedEventTypes"])
  );
}

export function getExistingOutputFiles(
  dir: string,
  pipelineKeys: string[],
): string[] {
  return resolveOutputFiles(dir, pipelineKeys);
}

export function listExistingPipelineBuilderFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".ts"));
}
