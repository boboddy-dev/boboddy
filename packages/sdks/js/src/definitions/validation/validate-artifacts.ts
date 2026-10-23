import {
  findArtifactFields,
  matchArtifactNode,
  type ArtifactField,
} from "../../contracts/artifacts";
import type { StepDefinitionSpec } from "../steps/define-step";
import {
  parseSourcePath,
  resolveSourcePath,
  resolveSourcePathNode,
  type JsonSchemaNode,
} from "./json-schema-paths";
import { listPaths, type DefinitionValidationIssue } from "./validation-issue";

const NUMERIC_SEGMENT = /^\d+$/;

function declaredFieldsHint(fields: readonly ArtifactField[]): string {
  const paths = fields.filter((field) => !field.inArray).map((f) => f.path);
  return paths.length > 0
    ? ` Artifact fields on this step: ${listPaths(paths)}.`
    : " This step declares no artifact fields.";
}

/**
 * Check: artifact fields (`x-boboddy-artifact`) never sit inside an array.
 * v1 has no way to say which array item a submitted file belongs to.
 */
export function checkArtifactFields(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    for (const field of findArtifactFields(step.resultSchemaJson ?? null)) {
      if (!field.inArray) continue;
      issues.push({
        check: "artifact-field",
        severity: "error",
        message:
          `Step "${step.key}" declares artifact field "${field.path}" inside an ` +
          `array. Artifact fields in arrays aren't supported; declare a fixed ` +
          `number of named artifact fields instead.`,
      });
    }
  }

  return issues;
}

/**
 * Check: a signal with `type: "artifact"` reads a single artifact field. Its
 * `sourcePath` must resolve to a node carrying `x-boboddy-artifact`, directly
 * or as a nullable `anyOf`, and must not index into an array. Paths that
 * provably don't resolve are left to `signal-source-path`; paths the schema is
 * too loose to resolve are rejected, since nothing proves they hold a file.
 */
export function checkArtifactSignals(
  steps: readonly StepDefinitionSpec[],
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];

  for (const step of steps) {
    const schema: JsonSchemaNode | null = step.resultSchemaJson ?? null;

    for (const signal of step.signalExtractorDefinitions) {
      if (signal.type !== "artifact") continue;
      const where =
        `Step "${step.key}" declares artifact signal "${signal.key}" with ` +
        `sourcePath "${signal.sourcePath}"`;
      const push = (cause: string): void => {
        issues.push({
          check: "artifact-signal",
          severity: "error",
          message: `${where}, but ${cause}`,
        });
      };

      if (!schema) {
        push(
          "the step has no result schema to declare the artifact field in. Add a `z.artifact()` field to the result.",
        );
        continue;
      }

      const fields = findArtifactFields(schema);
      const hint = declaredFieldsHint(fields);

      if (
        parseSourcePath(signal.sourcePath).some((s) => NUMERIC_SEGMENT.test(s))
      ) {
        push(
          `it indexes into an array; artifact signals in arrays aren't supported.${hint}`,
        );
        continue;
      }

      const node = resolveSourcePathNode(schema, signal.sourcePath);
      if (node === null) {
        if (resolveSourcePath(schema, signal.sourcePath).kind === "invalid") {
          continue;
        }
        push(
          `the result schema is too loose to show it is an artifact field.${hint}`,
        );
        continue;
      }

      if (!matchArtifactNode(node)) {
        push(`that field is not an artifact field.${hint}`);
      }
    }
  }

  return issues;
}
