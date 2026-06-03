import Ajv from "ajv/dist/2020";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnyJsonValue } from "../../../common/contracts/json";
import type {
  ProcessProjectWorkDeps,
  StartedClaimedExecution,
} from "../contracts/process-project-work-types";

const STEP_FINDINGS_SUBMISSION_RELATIVE_PATH =
  ".boboddy/step-findings-submission.json";
const CURRENT_EXECUTION_DIRECTORY_RELATIVE_PATH = ".boboddy/current-execution";
const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  `${CURRENT_EXECUTION_DIRECTORY_RELATIVE_PATH}/execution.json`;
const CURRENT_EXECUTION_GITIGNORE_RELATIVE_PATH =
  `${CURRENT_EXECUTION_DIRECTORY_RELATIVE_PATH}/.gitignore`;
const CURRENT_EXECUTION_GITIGNORE_CONTENT = "*\n.*\n!.gitignore\n";

export type CurrentExecutionInfo = {
  stepExecutionId: string;
  resultSchemaJson: Record<string, unknown> | null;
};

export function buildFindingsSubmissionPath(workspacePath: string): string {
  return path.join(workspacePath, STEP_FINDINGS_SUBMISSION_RELATIVE_PATH);
}

export function buildCurrentExecutionInfoPath(workspacePath: string): string {
  return path.join(workspacePath, CURRENT_EXECUTION_INFO_RELATIVE_PATH);
}

export async function writeCurrentExecutionInfoFile(
  workspacePath: string,
  input: CurrentExecutionInfo,
): Promise<string> {
  const currentExecutionInfoPath = buildCurrentExecutionInfoPath(workspacePath);
  await mkdir(path.dirname(currentExecutionInfoPath), { recursive: true });
  await writeFile(
    path.join(workspacePath, CURRENT_EXECUTION_GITIGNORE_RELATIVE_PATH),
    CURRENT_EXECUTION_GITIGNORE_CONTENT,
    "utf8",
  );
  await writeFile(
    currentExecutionInfoPath,
    `${JSON.stringify(input, null, 2)}\n`,
    "utf8",
  );
  return currentExecutionInfoPath;
}

async function tryReadFindingsSubmission(
  workspacePath: string,
): Promise<Record<string, unknown> | null> {
  const submissionPath = buildFindingsSubmissionPath(workspacePath);

  try {
    await access(submissionPath);
  } catch {
    return null;
  }

  const rawPayload = await readFile(submissionPath, "utf8");
  const parsed: unknown = JSON.parse(rawPayload);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

async function readCurrentExecutionInfo(
  workspacePath: string,
): Promise<CurrentExecutionInfo> {
  const currentExecutionInfoPath = buildCurrentExecutionInfoPath(workspacePath);

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
      `Current execution metadata file at ${currentExecutionInfoPath} must contain a JSON object`,
    );
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const stepExecutionId = parsedRecord["stepExecutionId"];
  const resultSchemaJson = parsedRecord["resultSchemaJson"];

  if (typeof stepExecutionId !== "string" || stepExecutionId.length === 0) {
    throw new Error(
      `Current execution metadata file at ${currentExecutionInfoPath} must contain a non-empty stepExecutionId`,
    );
  }

  if (
    resultSchemaJson !== null &&
    (typeof resultSchemaJson !== "object" || Array.isArray(resultSchemaJson))
  ) {
    throw new Error(
      `Current execution metadata file at ${currentExecutionInfoPath} must contain a JSON object or null resultSchemaJson`,
    );
  }

  return {
    stepExecutionId,
    resultSchemaJson: resultSchemaJson as Record<string, unknown> | null,
  };
}

function validateFindingsAgainstSchema(
  findings: AnyJsonValue,
  resultSchemaJson: Record<string, unknown> | null,
): { ok: true } | { ok: false; reason: string } {
  if (!resultSchemaJson) {
    return {
      ok: false,
      reason:
        "Step definition resultSchemaJson is missing; cannot complete agent submission.",
    };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ReturnType<Ajv["compile"]>;
  try {
    validate = ajv.compile(resultSchemaJson);
  } catch (error) {
    return {
      ok: false,
      reason: `Step definition resultSchemaJson is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const valid = validate(findings);
  if (valid) {
    return { ok: true };
  }

  const details = (validate.errors ?? [])
    .map(
      (issue) => `${issue.instancePath || "/"} ${issue.message ?? "invalid"}`,
    )
    .join("; ");

  return {
    ok: false,
    reason: `findingsJson does not match resultSchemaJson: ${details || "validation failed"}`,
  };
}

export async function tryPersistAgentFindings(
  deps: ProcessProjectWorkDeps,
  startedExecution: StartedClaimedExecution,
): Promise<"submitted" | "missing"> {
  const parsedPayload = await tryReadFindingsSubmission(
    startedExecution.environment.workspacePath,
  );

  if (!parsedPayload) {
    return "missing";
  }

  const currentExecutionInfo = await readCurrentExecutionInfo(
    startedExecution.environment.workspacePath,
  );

  if (currentExecutionInfo.stepExecutionId !== startedExecution.stepExecutionId) {
    throw new Error(
      `Current execution metadata stepExecutionId ${currentExecutionInfo.stepExecutionId} does not match running step execution ${startedExecution.stepExecutionId}`,
    );
  }

  const findingsJson = parsedPayload["findingsJson"] as AnyJsonValue;
  const validation = validateFindingsAgainstSchema(
    findingsJson,
    currentExecutionInfo.resultSchemaJson,
  );

  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  await deps.workerClient.completeStepExecution({
    stepExecutionId: startedExecution.stepExecutionId,
    claimToken: startedExecution.claimToken,
    resultJson: findingsJson,
    errorJson: null,
  });

  await rm(
    buildFindingsSubmissionPath(startedExecution.environment.workspacePath),
    {
      force: true,
    },
  );
  return "submitted";
}
