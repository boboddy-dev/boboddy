import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { createBoboddyClient } from "@boboddy/sdk";
import { ConfigurationError } from "../../../lib/errors";
import { createLazyLogger } from "../../../lib/logger";
import { deriveProjectName } from "../../project-config/infra/fs-project-config-repo";
import { readProjectConfig } from "../../project-config/application/read-project-config";
import { writeProjectConfig } from "../../project-config/application/write-project-config";

const execFileAsync = promisify(execFile);

const logger = createLazyLogger({
  name: "@boboddy/worker",
  scope: "local-config-setup",
});

async function getGitOriginUrl(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"]);
    return stdout.trim();
  } catch {
    throw new ConfigurationError(
      "Could not read git remote origin. Make sure this repo has a remote named 'origin'.",
    );
  }
}

export async function localConfigSetup(input: {
  client: ReturnType<typeof createBoboddyClient>;
  headers: { Authorization: string };
}): Promise<{ projectId: string } | null> {
  const existingConfig = await readProjectConfig();
  if (existingConfig?.projectId) {
    logger.info("Local setup already complete, skipping.");
    return null;
  }

  const gitUrl = await getGitOriginUrl();

  const listResponse = await input.client.projects.listProjects({ headers: input.headers });
  const projects: Array<{ id: string; gitUrl: string }> = listResponse.data ?? [];
  const existing = projects.find((p) => p.gitUrl === gitUrl);

  let projectId: string;
  if (existing) {
    projectId = existing.id;
    logger.info({ projectId }, "Found existing project for this repository.");
  } else {
    const name = deriveProjectName(gitUrl);
    const createResponse = await input.client.projects.createProject({
      body: { name, gitUrl, description: null },
      headers: input.headers,
    });
    if (!createResponse.data) {
      throw new ConfigurationError("Failed to create project. Please try again.");
    }
    projectId = createResponse.data.id;
    logger.info({ projectId, name }, "Created new project.");
  }

  await writeProjectConfig(projectId);
  logger.info({ projectId }, "Local init complete.");
  return { projectId };
}
