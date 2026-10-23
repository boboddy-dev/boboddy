import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { ARTIFACT_SCHEMA_KEYWORD } from "@boboddy/sdk/contracts/artifacts";
import {
  applyArtifactSubmissions,
  checkSubmittedArtifactFiles,
  findSubmittableArtifactFields,
  readStepArtifactSubmissions,
  type StepFindingsJson,
} from "@boboddy/sdk/contracts/step-artifact-submissions";
import {
  CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  loadCurrentExecutionInfo,
} from "./_shared/current-execution";
import { resolveWorktree } from "./_shared/resolve-worktree";

export { resolveWorktree as resolveFindingsWorktree };

export const BOBODDY_SUBMIT_STEP_FINDINGS_TOOL = "boboddy-submit-step-findings";

const DEFAULT_OUTPUT_PATH = ".boboddy/step-findings-submission.json";

type SubmitStepFindingsInput = { findingsJson: StepFindingsJson };

function compileResultSchema(
  resultSchemaJson: Record<string, unknown>,
): ReturnType<Ajv2020["compile"]> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addKeyword(ARTIFACT_SCHEMA_KEYWORD);
  try {
    return ajv.compile(resultSchemaJson);
  } catch (error) {
    throw new Error(
      `Invalid resultSchemaJson in ${CURRENT_EXECUTION_INFO_RELATIVE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * The dot path of the property a `required` error reports missing, so a
 * missing artifact field (already reported with a fix) isn't reported twice.
 */
function missingPropertyPath(issue: ErrorObject): string {
  const missing: unknown = issue.params["missingProperty"];
  if (issue.keyword !== "required" || typeof missing !== "string") return "";
  return [...issue.instancePath.split("/").slice(1), missing]
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

/**
 * Fills declared artifact fields in from `artifacts.json`, validates the
 * result against the current execution's stored result schema, and writes it
 * to {@link DEFAULT_OUTPUT_PATH} under the resolved worktree. Every problem
 * is reported in one error. Returns the JSON text the tool reports back to
 * the model.
 */
export async function submitStepFindings(
  input: SubmitStepFindingsInput,
  directory: string,
): Promise<string> {
  try {
    const worktree = await resolveWorktree(directory);
    console.warn(
      `[boboddy-submit-step-findings] start directory=${directory} resolvedWorktree=${worktree}`,
    );
    const currentExecutionInfo = await loadCurrentExecutionInfo(worktree);
    console.warn(
      `[boboddy-submit-step-findings] loaded current execution taskId=${currentExecutionInfo.taskId} hasResultSchema=${String(
        !!currentExecutionInfo.resultSchemaJson,
      )}`,
    );

    if (!currentExecutionInfo.resultSchemaJson) {
      throw new Error(
        `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} is missing resultSchemaJson`,
      );
    }

    const validate = compileResultSchema(currentExecutionInfo.resultSchemaJson);
    const artifactFields = findSubmittableArtifactFields(
      currentExecutionInfo.resultSchemaJson,
    );
    const submissions = await readStepArtifactSubmissions(worktree);
    const filled = applyArtifactSubmissions({
      findings: input.findingsJson,
      fields: artifactFields,
      submissions,
      mode: "fill",
    });
    const problems = [
      ...filled.problems,
      ...(await checkSubmittedArtifactFiles({
        workspacePath: worktree,
        fields: artifactFields,
        submissions,
      })),
    ];

    const valid = validate(filled.findings) === true;
    console.warn(
      `[boboddy-submit-step-findings] validation valid=${String(valid)} artifactProblems=${String(problems.length)}`,
    );
    const artifactPaths = new Set(artifactFields.map((field) => field.path));
    const schemaErrors = (validate.errors ?? []).filter(
      (issue) => !artifactPaths.has(missingPropertyPath(issue)),
    );
    if (!valid && (schemaErrors.length > 0 || problems.length === 0)) {
      const details = schemaErrors
        .map(
          (issue) =>
            `${issue.instancePath || "/"} ${issue.message ?? "invalid"}`,
        )
        .join("; ");
      problems.push(
        `findingsJson does not match resultSchemaJson: ${details || "validation failed"}`,
      );
    }
    if (problems.length > 0) {
      throw new Error(problems.join("\n"));
    }

    const filePath = path.join(worktree, DEFAULT_OUTPUT_PATH);
    console.warn(
      `[boboddy-submit-step-findings] writing findings outputPath=${filePath}`,
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify({ findingsJson: filled.findings }, null, 2)}\n`,
      "utf8",
    );
    console.warn("[boboddy-submit-step-findings] write complete");

    return JSON.stringify(
      {
        ok: true,
        outputPath: DEFAULT_OUTPUT_PATH,
      },
      null,
      2,
    );
  } catch (error) {
    console.error(
      `[boboddy-submit-step-findings] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

/**
 * The `boboddy-submit-step-findings` tool, bound to the directory the plugin
 * was loaded for (`ctx.location.directory`). `findingsJson` is deliberately
 * unconstrained here: its real schema is per-step and lives on disk, so it is
 * validated inside {@link submitStepFindings} instead.
 */
export function createBoboddySubmitStepFindingsTool(
  directory: string,
): ToolInfo {
  return {
    name: BOBODDY_SUBMIT_STEP_FINDINGS_TOOL,
    description:
      "Submit Boboddy step findings as JSON. The tool loads the current execution schema from disk and validates findingsJson against it. Artifact fields are filled in from files submitted with boboddy-submit-artifact; leave them out of findingsJson.",
    input: {
      type: "object",
      properties: {
        findingsJson: {
          description: "Structured findings payload for the current step",
        },
      },
      required: ["findingsJson"],
    },
    options: { codemode: false },
    execute: async (input) => ({
      content: await submitStepFindings(
        input as SubmitStepFindingsInput,
        directory,
      ),
    }),
  };
}
