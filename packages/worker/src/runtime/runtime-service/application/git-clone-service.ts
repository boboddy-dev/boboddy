import type { GitCacheLogger } from "./git-mirror-cache";

export type CloneRepositoryInput = {
  gitUrl: string;
  workspacePath: string;
  /** Receives the git mirror cache's visible log lines, when provided. */
  logger?: GitCacheLogger | undefined;
};

export type CloneRepositoryResult = {
  resolvedBranch: string;
};

export type GitCloneService = {
  cloneRepository(input: CloneRepositoryInput): Promise<CloneRepositoryResult>;
};
