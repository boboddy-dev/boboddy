import {
  createPipelineDefinitionsClient,
  type StepDefinitionRef,
} from "@boboddy/sdk/definitions/pipelines";
import type { PipelineDefinitionSpec } from "@boboddy/sdk/definitions/pipelines";

export type StepDefEntry = StepDefinitionRef;

type PipelineDefinitionsClient = {
  listByProjectId: (
    projectId: string,
    options: { headers: Record<string, unknown> },
  ) => Promise<Array<{ key: string }>>;
  upsertFromSpec: (
    projectId: string,
    spec: PipelineDefinitionSpec,
    stepDefs: ReadonlyArray<StepDefinitionRef>,
    options: { headers: Record<string, unknown> },
  ) => Promise<unknown>;
};

type PipelinePushLogger = {
  info: (obj: unknown, msg?: string) => void;
};

export interface PushPipelineDefinitionsOptions {
  projectId: string;
  baseUrl: string;
  headers: { Authorization: string };
  logger: PipelinePushLogger;
  specs: PipelineDefinitionSpec[];
  stepDefs: StepDefEntry[];
  createClient?: (baseUrl: string) => PipelineDefinitionsClient;
}

export interface PushPipelineDefinitionsResult {
  pushed: number;
}

function extractRoutePipelineKeys(policy: {
  defaultEventType: string;
  defaultEventParamsJson: Record<string, unknown> | null;
  rulesJson: { rules: Array<{ event: { type: string; params?: Record<string, unknown> } }> };
}): string[] {
  const keys: string[] = [];
  if (
    policy.defaultEventType === "route" &&
    typeof policy.defaultEventParamsJson?.["pipelineKey"] === "string"
  ) {
    keys.push(policy.defaultEventParamsJson["pipelineKey"] as string);
  }
  for (const rule of policy.rulesJson.rules) {
    if (
      rule.event.type === "route" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      keys.push(rule.event.params["pipelineKey"] as string);
    }
  }
  return keys;
}

export async function pushPipelineDefinitions(
  options: PushPipelineDefinitionsOptions,
): Promise<PushPipelineDefinitionsResult> {
  const createClient =
    options.createClient ?? createPipelineDefinitionsClient;
  const client = createClient(options.baseUrl);

  if (options.specs.length === 0) {
    return { pushed: 0 };
  }

  // Validate cross-pipeline route references before touching the server.
  const localPipelineKeys = new Set(options.specs.map((s) => s.key));
  const existingPipelines = await client.listByProjectId(options.projectId, {
    headers: options.headers,
  });
  const serverPipelineKeys = new Set(existingPipelines.map((p) => p.key));
  const knownPipelineKeys = new Set([...localPipelineKeys, ...serverPipelineKeys]);

  for (const spec of options.specs) {
    for (const step of spec.steps) {
      const routeKeys = extractRoutePipelineKeys(step.advancementPolicyDefinition);
      for (const routeKey of routeKeys) {
        if (!knownPipelineKeys.has(routeKey)) {
          throw new Error(
            `Pipeline "${spec.key}" step "${step.stepKey}" routes to pipeline "${routeKey}", ` +
              `but no pipeline with that key was found on the server or in the current push batch. ` +
              `Push the target pipeline first.`,
          );
        }
      }
    }
  }

  for (const spec of options.specs) {
    await client.upsertFromSpec(
      options.projectId,
      spec,
      options.stepDefs,
      { headers: options.headers },
    );

    options.logger.info(
      { key: spec.key, version: spec.version },
      `✓ ${spec.key} v${String(spec.version)} → upserted`,
    );
  }

  options.logger.info(
    { count: options.specs.length },
    `Pushed ${String(options.specs.length)} pipeline definition(s)`,
  );

  return { pushed: options.specs.length };
}
