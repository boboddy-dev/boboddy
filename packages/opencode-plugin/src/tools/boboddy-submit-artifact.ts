import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  artifactAcceptsFile,
  artifactFileExtension,
  artifactPlatforms,
  isEmbeddableArtifactExtension,
  type ArtifactField,
} from "@boboddy/sdk/contracts/artifacts";
import {
  STEP_ARTIFACTS_RELATIVE_DIR,
  buildStepArtifactsDir,
  findSubmittableArtifactFields,
  readStepArtifactSubmissions,
  writeStepArtifactSubmissions,
  type SubmittedArtifact,
} from "@boboddy/sdk/contracts/step-artifact-submissions";
import {
  CURRENT_EXECUTION_INFO_RELATIVE_PATH,
  tryLoadCurrentExecutionInfo,
} from "./_shared/current-execution";
import { resolveWorktree } from "./_shared/resolve-worktree";

export const BOBODDY_SUBMIT_ARTIFACT_TOOL = "boboddy-submit-artifact";

type SubmitArtifactInput = {
  path?: unknown;
  field?: unknown;
  name?: unknown;
};

export type SubmitArtifactResult = {
  ok: true;
  field: string | null;
  stored: string;
  warnings: string[];
};

const GENERIC_DESCRIPTION = [
  "Submit a file produced by this step. The file is copied into the step's artifacts folder.",
  "If the step declares artifact fields, submit each declared file with `field` set to the field name. Other files can be submitted without `field`, optionally with `name` for the stored file name.",
  "Don't put artifact paths in findingsJson; boboddy-submit-step-findings fills those fields in.",
].join("\n");

function describeAccept(field: ArtifactField): string {
  return field.accept.length > 0 ? field.accept.join(", ") : "any file";
}

function describeField(field: ArtifactField): string {
  const summary = `${field.path} (${describeAccept(field)}; ${field.nullable ? "optional" : "required"})`;
  return field.description ? `${summary}: ${field.description}` : summary;
}

/**
 * The tool description for a step: its declared artifact fields when the
 * result schema is known, a generic guide otherwise.
 */
export function buildSubmitArtifactDescription(
  resultSchemaJson: Record<string, unknown> | null | undefined,
): string {
  if (resultSchemaJson === undefined) return GENERIC_DESCRIPTION;
  const fields = findSubmittableArtifactFields(resultSchemaJson);
  if (fields.length === 0) {
    return [
      "Submit a file produced by this step. This step declares no artifact fields.",
      "Submit files without `field`, optionally with `name` for the stored file name.",
    ].join("\n");
  }
  return [
    "Submit a file produced by this step. This step declares:",
    ...fields.map((field) => `- ${describeField(field)}`),
    "Submit declared files with `field`. Don't put artifact paths in findingsJson;",
    "boboddy-submit-step-findings fills those fields in.",
    "Other files can be submitted without `field`, optionally with `name` for the stored file name.",
  ].join("\n");
}

function describeDeclaredFields(fields: readonly ArtifactField[]): string {
  return fields.length > 0
    ? `This step declares: ${fields.map(describeField).join("; ")}.`
    : "This step declares no artifact fields; submit the file without `field`.";
}

function optionalString(
  value: SubmitArtifactInput["field"],
  key: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`\`${key}\` must be a non-empty string when given.`);
  }
  return value.trim();
}

function normalizeStoredName(name: string): string {
  const normalized = path.posix.normalize(name.replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/")
  ) {
    throw new Error(
      `\`name\` must be a file path inside ${STEP_ARTIFACTS_RELATIVE_DIR}, e.g. "screens/banner.png". Got "${name}".`,
    );
  }
  return normalized;
}

async function resolveDeclaredField(
  worktree: string,
  fieldPath: string,
): Promise<ArtifactField> {
  const executionInfo = await tryLoadCurrentExecutionInfo(worktree);
  if (!executionInfo) {
    throw new Error(
      `Can't check \`field: "${fieldPath}"\`: ${CURRENT_EXECUTION_INFO_RELATIVE_PATH} could not be read. Submit the file without \`field\` instead.`,
    );
  }
  const fields = findSubmittableArtifactFields(executionInfo.resultSchemaJson);
  const field = fields.find((candidate) => candidate.path === fieldPath);
  if (!field) {
    throw new Error(
      `\`${fieldPath}\` is not a declared artifact field. ${describeDeclaredFields(fields)}`,
    );
  }
  return field;
}

async function checkSourceFile(sourcePath: string): Promise<number> {
  const stats = await stat(sourcePath).catch(() => null);
  if (!stats) throw new Error(`File not found: ${sourcePath}`);
  if (!stats.isFile()) throw new Error(`Not a regular file: ${sourcePath}`);
  if (stats.size === 0) throw new Error(`File is empty: ${sourcePath}`);
  return stats.size;
}

function linkOnlyWarning(stored: string): string | null {
  const extension = artifactFileExtension(stored);
  const embeddable = artifactPlatforms.some((platform) =>
    isEmbeddableArtifactExtension(platform, extension),
  );
  if (embeddable) return null;
  const kind = extension ? `${extension} files` : "files without an extension";
  return `No platform embeds ${kind}, so ${stored} will be linked rather than embedded in comments.`;
}

/**
 * Copies a file the agent produced into the step-artifacts folder and records
 * it in `.boboddy/current-execution/artifacts.json`. A declared field is
 * stored as `<field path>.<ext>`; an undeclared file keeps its basename or
 * uses `name`.
 */
export async function submitArtifact(
  input: SubmitArtifactInput,
  directory: string,
): Promise<SubmitArtifactResult> {
  if (typeof input.path !== "string" || input.path.trim().length === 0) {
    throw new Error("`path` must be the path of the file to submit.");
  }
  const fieldPath = optionalString(input.field, "field");
  const name = optionalString(input.name, "name");
  if (fieldPath && name) {
    throw new Error(
      "Pass either `field` (a declared artifact field) or `name` (an undeclared file), not both. Declared fields are stored under the field name.",
    );
  }

  const worktree = await resolveWorktree(directory);
  const sourcePath = path.resolve(worktree, input.path.trim());
  const field = fieldPath
    ? await resolveDeclaredField(worktree, fieldPath)
    : null;
  const sizeBytes = await checkSourceFile(sourcePath);

  if (field && !artifactAcceptsFile(field.accept, sourcePath)) {
    const extension = artifactFileExtension(sourcePath) || "no extension";
    throw new Error(
      `\`${field.path}\` accepts ${describeAccept(field)}, but ${path.basename(sourcePath)} has ${extension}.${
        field.description ? ` ${field.path}: ${field.description}` : ""
      }`,
    );
  }

  const stored = field
    ? `${field.path}${artifactFileExtension(sourcePath)}`
    : normalizeStoredName(name ?? path.basename(sourcePath));

  const submissions = await readStepArtifactSubmissions(worktree);
  if (!field) {
    const claimedBy = Object.entries(submissions.fields).find(
      ([, entry]) => entry.stored === stored,
    );
    if (claimedBy) {
      throw new Error(
        `${stored} is already stored for \`${claimedBy[0]}\`. Use a different \`name\`.`,
      );
    }
  }

  const artifactsDir = buildStepArtifactsDir(worktree);
  const destination = path.join(artifactsDir, stored);
  if (destination !== sourcePath) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
  }

  const warnings: string[] = [];
  const entry: SubmittedArtifact = {
    stored,
    sourcePath: input.path.trim(),
    sizeBytes,
  };
  const fields = { ...submissions.fields };
  let extra = submissions.extra.filter((item) => item.stored !== stored);

  if (field) {
    const previous = fields[field.path];
    if (previous) {
      if (previous.stored !== stored) {
        await rm(path.join(artifactsDir, previous.stored), { force: true });
      }
      warnings.push(
        `Replaced the earlier submission for \`${field.path}\` (${previous.stored}).`,
      );
    }
    fields[field.path] = entry;
  } else {
    if (extra.length !== submissions.extra.length) {
      warnings.push(`Replaced the earlier submission stored as ${stored}.`);
    }
    extra = [...extra, entry];
  }

  await writeStepArtifactSubmissions(worktree, { fields, extra });

  const linkWarning = linkOnlyWarning(stored);
  if (linkWarning) warnings.push(linkWarning);

  return { ok: true, field: field?.path ?? null, stored, warnings };
}

/**
 * The `boboddy-submit-artifact` tool, bound to the plugin's directory. Its
 * description lists the current step's declared artifact fields, read from
 * `execution.json` when the plugin loads.
 */
export async function createBoboddySubmitArtifactTool(
  directory: string,
): Promise<ToolInfo> {
  const executionInfo = await tryLoadCurrentExecutionInfo(
    await resolveWorktree(directory),
  );
  return {
    name: BOBODDY_SUBMIT_ARTIFACT_TOOL,
    description: buildSubmitArtifactDescription(
      executionInfo ? executionInfo.resultSchemaJson : undefined,
    ),
    input: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path of the file to submit, absolute or relative to the workspace. The file is copied; the original stays in place.",
        },
        field: {
          type: "string",
          description:
            "The declared artifact field this file fills in. Submitting the same field again replaces the earlier file.",
        },
        name: {
          type: "string",
          description:
            "Stored file name for an undeclared artifact, relative to the artifacts folder. Defaults to the file's basename.",
        },
      },
      required: ["path"],
    },
    options: { codemode: false },
    execute: async (input) => ({
      content: JSON.stringify(
        await submitArtifact(input as SubmitArtifactInput, directory),
        null,
        2,
      ),
    }),
  };
}
