import {
  artifactPlatforms,
  EMBEDDABLE_ARTIFACT_EXTENSIONS,
  matchArtifactNode,
} from "../../contracts/artifacts";
import { findArtifactMarkers } from "../../contracts/artifact-markers";
import {
  isWorkingNodeDefinition,
  type NodeDefinitionSpec,
  type PipelineDefinitionSpec,
} from "../pipelines/define-pipeline";
import type { StepDefinitionSpec } from "../steps/define-step";
import { resolveSourcePathNode } from "./json-schema-paths";
import { listPaths, type DefinitionValidationIssue } from "./validation-issue";

type SignalMarker = {
  readonly kind: "embed" | "link";
  readonly stepKey: string;
  readonly signalKey: string;
};

const isPlaceholder = (key: string): boolean => /^<[^<>]*>$/.test(key);

/**
 * Signal markers (`artifact:signal/<stepKey>/<signalKey>`) in a step's
 * prompt. `Artifact.embed` / `Artifact.link` produce marker strings, and the
 * prompt is the only place a definition carries them. A marker whose keys are
 * `<...>` placeholders documents the format (the notifications feature's
 * prompt does) and points at nothing.
 */
function signalMarkers(step: StepDefinitionSpec): SignalMarker[] {
  if (!step.prompt) return [];
  return findArtifactMarkers(step.prompt).flatMap((marker) =>
    marker.ref.type === "signal" &&
    !isPlaceholder(marker.ref.stepKey) &&
    !isPlaceholder(marker.ref.signalKey)
      ? [{ kind: marker.kind, ...marker.ref }]
      : [],
  );
}

function nodeStepKeys(node: NodeDefinitionSpec): string[] {
  if (isWorkingNodeDefinition(node)) return [node.stepKey];
  if (node.kind === "parallel") {
    return Object.values(node.branches).map((branch) => branch.stepKey);
  }
  return [];
}

const markerLabel = (marker: SignalMarker): string =>
  `${marker.kind === "embed" ? "Artifact.embed" : "Artifact.link"}(` +
  `"signal/${marker.stepKey}/${marker.signalKey}")`;

/**
 * Check: every signal marker in a pipeline's step prompts names a step that
 * runs in that pipeline. A marker for a step outside the pipeline can never
 * resolve, so its comment would always be suppressed.
 */
function checkMarkerStepsInPipeline(
  pipelines: readonly PipelineDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const pipeline of pipelines) {
    const pipelineStepKeys = new Set(
      pipeline.nodeDefinitions.flatMap(nodeStepKeys),
    );

    for (const node of pipeline.nodeDefinitions) {
      for (const stepKey of new Set(nodeStepKeys(node))) {
        for (const step of stepsByKey.get(stepKey) ?? []) {
          for (const marker of signalMarkers(step)) {
            if (pipelineStepKeys.has(marker.stepKey)) continue;
            issues.push({
              check: "artifact-marker",
              severity: "error",
              pipelineKey: pipeline.key,
              nodeKey: node.nodeKey,
              message:
                `Pipeline "${pipeline.key}" node "${node.nodeKey}" uses ` +
                `${markerLabel(marker)}, but step "${marker.stepKey}" is not ` +
                `in the pipeline, so the artifact can never resolve. Steps in ` +
                `"${pipeline.key}": ${listPaths([...pipelineStepKeys].sort())}.`,
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Check: a signal marker names a declared artifact signal, and an embed
 * marker points at a field some platform can show inline. Only steps in this
 * batch can be checked.
 */
function checkMarkerTargets(
  steps: readonly StepDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];
  const embeddable = new Set(
    artifactPlatforms.flatMap((platform) => [
      ...EMBEDDABLE_ARTIFACT_EXTENSIONS[platform],
    ]),
  );

  for (const step of steps) {
    for (const marker of signalMarkers(step)) {
      const targets = stepsByKey.get(marker.stepKey);
      if (!targets) continue;
      const where = `Step "${step.key}" uses ${markerLabel(marker)}`;

      for (const target of targets) {
        const signal = target.signalExtractorDefinitions.find(
          (candidate) => candidate.key === marker.signalKey,
        );
        if (!signal || signal.type !== "artifact") {
          const declared = target.signalExtractorDefinitions
            .filter((candidate) => candidate.type === "artifact")
            .map((candidate) => candidate.key);
          issues.push({
            check: "artifact-marker",
            severity: "error",
            message:
              `${where}, but step "${target.key}" declares no artifact signal ` +
              `"${marker.signalKey}". Artifact signals on "${target.key}": ` +
              `${declared.length > 0 ? listPaths(declared) : "(none)"}.`,
          });
          continue;
        }

        if (marker.kind !== "embed" || !target.resultSchemaJson) continue;
        const node = resolveSourcePathNode(
          target.resultSchemaJson,
          signal.sourcePath,
        );
        const accept = node ? matchArtifactNode(node)?.accept : undefined;
        if (!accept || accept.length === 0) continue;
        if (accept.some((extension) => embeddable.has(extension))) continue;
        issues.push({
          check: "artifact-marker",
          severity: "warning",
          message:
            `${where}, but the field accepts only ${accept.join(", ")}, which ` +
            `no platform can embed, so it will always be linked. Embeddable ` +
            `extensions: ${[...embeddable].join(", ")}.`,
        });
      }
    }
  }

  return issues;
}

export function checkArtifactMarkers(
  pipelines: readonly PipelineDefinitionSpec[],
  steps: readonly StepDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  return [
    ...checkMarkerTargets(steps, stepsByKey),
    ...checkMarkerStepsInPipeline(pipelines, stepsByKey),
  ];
}
