import type { createBoboddyClient } from "@boboddy/sdk";
import { ConfigurationError } from "../../../lib/errors";
import { createLazyLogger } from "../../../lib/logger";
import { analyzeRepo, type RepoAnalysis } from "./repo-analysis";

const WEB_REPRO_PLAYWRIGHT_TEMPLATE_KEY = "web_repro_playwright";

const logger = createLazyLogger({
  name: "@boboddy/worker",
  scope: "recommend-pipelines",
});

interface RecommendedSetup {
  templateKey: typeof WEB_REPRO_PLAYWRIGHT_TEMPLATE_KEY;
  templateName: string;
  pipelineName: string;
  rationale: string;
}

interface StepDefinitionTemplateSummary {
  id: string;
  key: string;
}

interface StepDefinitionSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  version: number;
}

interface CreatedPipelineSummary {
  id: string;
  key: string;
}

function getFrameworkLabel(analysis: RepoAnalysis): string {
  switch (analysis.framework) {
    case "nextjs":
      return "Next.js";
    case "vite":
      return "Vite + React";
    case "react":
      return "React";
    default:
      return "web app";
  }
}

function getRecommendedSetup(analysis: RepoAnalysis): RecommendedSetup | null {
  if (analysis.kind !== "web_app") {
    return null;
  }

  const frameworkLabel = getFrameworkLabel(analysis);
  const playwrightNote = analysis.hasPlaywright
    ? " Existing Playwright usage makes this a strong fit."
    : "";

  return {
    templateKey: WEB_REPRO_PLAYWRIGHT_TEMPLATE_KEY,
    templateName: "Web Repro Playwright",
    pipelineName: "Web Repro Playwright",
    rationale: `Detected a ${frameworkLabel} project.${playwrightNote}`,
  };
}

function toKeySegment(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

async function createRecommendedSetupForProject(input: {
  baseUrl: string;
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  projectId: string;
  recommendation: RecommendedSetup;
  appAccessInstructions: string;
}): Promise<CreatedPipelineSummary> {
  const templatesResponse = await input.client.stepDefinitionTemplates.listStepDefinitionTemplates(
    { headers: input.headers },
  );
  const templates = (templatesResponse.data ?? []) as StepDefinitionTemplateSummary[];
  const template = templates.find((item) => item.key === input.recommendation.templateKey);

  if (!template) {
    throw new ConfigurationError(
      `Could not find the ${input.recommendation.templateName} template.`,
    );
  }

  const stepDefinitionResponse =
    await input.client.stepDefinitionTemplates.instantiateStepDefinitionTemplate({
      path: { stepDefinitionTemplateId: template.id },
      body: {
        projectId: input.projectId,
        name: input.recommendation.templateName,
        parameterValues: {
          app_access_instructions: input.appAccessInstructions,
          additional_instructions: "",
        },
      },
      headers: input.headers,
    });
  const stepDefinition = stepDefinitionResponse.data as StepDefinitionSummary | null | undefined;

  if (!stepDefinition) {
    throw new ConfigurationError(
      `Failed to create the ${input.recommendation.templateName} step definition.`,
    );
  }

  const pipelineKey = `${toKeySegment(input.recommendation.pipelineName)}_init_${Date.now().toString(36)}`;
  const pipelineResponse = await fetch(new URL("/api/linear-pipeline-definitions", input.baseUrl), {
    method: "POST",
    headers: {
      Authorization: input.headers.Authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectId: input.projectId,
      key: pipelineKey,
      name: input.recommendation.pipelineName,
      description: "Created during init from the recommended template.",
      version: 1,
      status: "active",
      stepDefinitions: [
        {
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: stepDefinition.version,
          key: stepDefinition.key,
          name: stepDefinition.name,
          description: stepDefinition.description,
          position: 1,
          inputBindingsJson: {
            title: { source: "pipeline_input", path: "$.title" },
            description: { source: "pipeline_input", path: "$.description" },
          },
          timeoutSeconds: 900,
          retryPolicyJson: null,
          advancementPolicyDefinition: {
            rulesJson: { rules: [] },
            defaultEventType: "continue",
            defaultEventParamsJson: null,
            allowedEventTypes: ["continue"],
          },
        },
      ],
    }),
  });

  if (!pipelineResponse.ok) {
    const errorBody = (await pipelineResponse.json().catch(() => null)) as { title?: string } | null;
    throw new ConfigurationError(
      errorBody?.title ?? `Failed to create the ${input.recommendation.pipelineName} pipeline.`,
    );
  }

  const pipeline = (await pipelineResponse.json()) as CreatedPipelineSummary | null | undefined;

  if (!pipeline) {
    throw new ConfigurationError(
      `Failed to create the ${input.recommendation.pipelineName} pipeline.`,
    );
  }

  return pipeline;
}

export async function recommendPipelines(input: {
  baseUrl: string;
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
  projectId: string;
  accepted: boolean;
  appAccessInstructions?: string | null;
}): Promise<void> {
  const analysis = await analyzeRepo();
  const recommendation = getRecommendedSetup(analysis);

  if (!recommendation) {
    return;
  }

  logger.info({ rationale: recommendation.rationale }, `Recommended setup: ${recommendation.templateName}`);

  if (!input.accepted) {
    logger.info("Skipped recommended setup.");
    return;
  }

  if (!input.appAccessInstructions) {
    logger.info("Skipped recommended setup.");
    return;
  }

  const pipeline = await createRecommendedSetupForProject({
    baseUrl: input.baseUrl,
    client: input.client,
    headers: input.headers,
    projectId: input.projectId,
    recommendation,
    appAccessInstructions: input.appAccessInstructions,
  });
  logger.info(
    { pipelineId: pipeline.id, pipelineKey: pipeline.key },
    `Created recommended pipeline: ${recommendation.pipelineName}`,
  );
}
