import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StepDefinitionSpec } from "@boboddy/sdk/definitions/steps";
import { createStepDefinitionsClient } from "@boboddy/sdk/definitions/steps";
import { loadStepsFromDirectory } from "./load-steps-from-directory";

export const STEPS_DIR = ".boboddy/steps";
export const PIPELINE_BUILDER_DIR = ".boboddy/pipeline-builder";

type StepPushLogger = {
  info: (obj: unknown, msg?: string) => void;
};

type StepDefinitionsClient = {
  upsertFromSpec: (
    projectId: string,
    spec: StepDefinitionSpec,
    options: { headers: { Authorization: string } },
  ) => Promise<unknown>;
};

interface PushStepDefinitionsOptions {
  projectId: string;
  baseUrl: string;
  headers: { Authorization: string };
  logger: StepPushLogger;
  dir?: string;
  cwd?: string;
  skipMissingDirectory?: boolean;
  loadSteps?: (dir: string) => Promise<StepDefinitionSpec[]>;
  createClient?: (baseUrl: string) => StepDefinitionsClient;
}

export interface PushStepDefinitionsResult {
  found: number;
  upserted: number;
  skippedMissingDirectory: boolean;
}

export async function pushStepDefinitions(
  options: PushStepDefinitionsOptions,
): Promise<PushStepDefinitionsResult> {
  const cwd = options.cwd ?? process.cwd();
  const dir = join(cwd, options.dir ?? STEPS_DIR);

  if (!existsSync(dir)) {
    if (options.skipMissingDirectory) {
      return {
        found: 0,
        upserted: 0,
        skippedMissingDirectory: true,
      };
    }
  }

  const loadSteps = options.loadSteps ?? loadStepsFromDirectory;
  const client = (options.createClient ?? createStepDefinitionsClient)(
    options.baseUrl,
  );
  const specs = await loadSteps(dir);

  options.logger.info(
    { count: specs.length },
    `Found ${String(specs.length)} step definition(s)`,
  );

  if (specs.length === 0) {
    options.logger.info("Nothing to push.");
    return {
      found: 0,
      upserted: 0,
      skippedMissingDirectory: false,
    };
  }

  let upserted = 0;
  for (const spec of specs) {
    await client.upsertFromSpec(options.projectId, spec, {
      headers: options.headers,
    });
    upserted++;
    options.logger.info(
      { key: spec.key, version: spec.version },
      `✓ ${spec.key} v${String(spec.version)} → upserted`,
    );
  }

  options.logger.info(
    { upserted },
    `Pushed ${String(upserted)} step definition(s)`,
  );

  return {
    found: specs.length,
    upserted,
    skippedMissingDirectory: false,
  };
}
