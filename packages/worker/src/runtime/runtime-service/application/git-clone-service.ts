export type CloneRepositoryInput = {
  gitUrl: string;
  workspacePath: string;
};

export type CloneRepositoryResult = {
  resolvedBranch: string;
};

export type GitCloneService = {
  cloneRepository(input: CloneRepositoryInput): Promise<CloneRepositoryResult>;
};
