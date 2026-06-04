import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { resolveWorktree } from "./_shared/resolve-worktree";

export { resolveWorktree as resolveFindingsWorktree };

const DEFAULT_OUTPUT_PATH = ".boboddy/step-findings-submission.json";
const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".boboddy/current-execution/execution.json";

type CurrentExecutionInfo = {
  stepExecutionId: string;
  resultSchemaJson: Record<string, unknown> | null;
};

async function loadCurrentExecutionInfo(
  worktree: string,
): Promise<CurrentExecutionInfo> {
  const currentExecutionInfoPath = path.join(
    worktree,
    CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  );

  try {
    await access(currentExecutionInfoPath);
  } catch {
    throw new Error(
      `Current execution metadata file not found at ${currentExecutionInfoPath}`,
    );
  }

  const rawPayload = await readFile(currentExecutionInfoPath, "utf8");
  const parsed: unknown = JSON.parse(rawPayload);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a JSON object`,
    );
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const stepExecutionId = parsedRecord["stepExecutionId"];
  const resultSchemaJson = parsedRecord["resultSchemaJson"];

  if (typeof stepExecutionId !== "string" || stepExecutionId.length === 0) {
    throw new Error(
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a non-empty stepExecutionId`,
    );
  }

  if (
    resultSchemaJson !== null &&
    (typeof resultSchemaJson !== "object" || Array.isArray(resultSchemaJson))
  ) {
    throw new Error(
      `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} must contain a JSON object or null resultSchemaJson`,
    );
  }

  return {
    stepExecutionId,
    resultSchemaJson: resultSchemaJson as Record<string, unknown> | null,
  };
}

const boboddySubmitStepFindings: ToolDefinition = tool({
  description:
    "Submit Boboddy step findings as JSON. The tool loads the current execution schema from disk and validates findingsJson against it.",
  args: {
    findingsJson: tool.schema
      .json()
      .describe("Structured findings payload for the current step"),
  },
  async execute(args, context) {
    try {
      const worktree = await resolveWorktree(context.worktree);
      console.log(
        `[boboddy-submit-step-findings] start worktree=${context.worktree} resolvedWorktree=${worktree}`,
      );
      const currentExecutionInfo = await loadCurrentExecutionInfo(worktree);
      console.log(
        `[boboddy-submit-step-findings] loaded current execution stepExecutionId=${currentExecutionInfo.stepExecutionId} hasResultSchema=${String(
          !!currentExecutionInfo.resultSchemaJson,
        )}`,
      );

      if (!currentExecutionInfo.resultSchemaJson) {
        throw new Error(
          `Current execution metadata file at ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} is missing resultSchemaJson`,
        );
      }

      const ajv = new Ajv2020({ allErrors: true, strict: false });
      let validate: ReturnType<Ajv2020["compile"]>;

      try {
        validate = ajv.compile(currentExecutionInfo.resultSchemaJson);
      } catch (error) {
        throw new Error(
          `Invalid resultSchemaJson in ${CURRENT_EXECUTION_INFO_RELATIVE_PATH}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }

      const valid = validate(args.findingsJson);
      console.log(
        `[boboddy-submit-step-findings] validation valid=${String(valid)}`,
      );
      if (!valid) {
        const details = (validate.errors ?? [])
          .map(
            (issue) =>
              `${issue.instancePath || "/"} ${issue.message ?? "invalid"}`,
          )
          .join("; ");
        throw new Error(
          `findingsJson does not match resultSchemaJson: ${details || "validation failed"}`,
        );
      }

      const filePath = path.join(worktree, DEFAULT_OUTPUT_PATH);
      console.log(
        `[boboddy-submit-step-findings] writing findings outputPath=${filePath}`,
      );
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        `${JSON.stringify({ findingsJson: args.findingsJson }, null, 2)}\n`,
        "utf8",
      );
      console.log("[boboddy-submit-step-findings] write complete");

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
  },
});

export default boboddySubmitStepFindings;
