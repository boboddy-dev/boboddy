import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceManager } from "../application/workspace-manager";
import {
  chmodRecursiveWithDocker,
  isPermissionError,
} from "./docker-chmod-fallback";

const DEFAULT_ROOT_DIR = path.join(
  os.tmpdir(),
  "boboddy-project-runtime-sessions",
);

async function removeWorkspaceWithHostFs(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

async function removeWorkspaceWithDocker(workspacePath: string): Promise<void> {
  await chmodRecursiveWithDocker(workspacePath);
}

async function removeWorkspacePath(workspacePath: string): Promise<void> {
  try {
    await removeWorkspaceWithHostFs(workspacePath);
  } catch (error) {
    if (!isPermissionError(error instanceof Error ? error : undefined)) {
      throw error;
    }

    await removeWorkspaceWithDocker(workspacePath);
    await removeWorkspaceWithHostFs(workspacePath);
  }
}

export class LocalWorkspaceManager implements WorkspaceManager {
  constructor(private readonly rootDir = DEFAULT_ROOT_DIR) {}

  async createWorkspace(input: {
    sessionId: string;
  }): Promise<{ workspacePath: string }> {
    const workspacePath = path.join(this.rootDir, input.sessionId);
    await removeWorkspacePath(workspacePath);
    await mkdir(workspacePath, { recursive: true });
    return { workspacePath };
  }

  async removeWorkspace(workspacePath: string): Promise<void> {
    await removeWorkspacePath(workspacePath);
  }
}
