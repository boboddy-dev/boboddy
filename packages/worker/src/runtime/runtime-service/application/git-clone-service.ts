export type CloneRepositoryInput = {
  gitUrl: string;
  workspacePath: string;
  requestedBranch?: string | null | undefined;
};

export type CloneRepositoryResult = {
  resolvedBranch: string;
};

export type GitCloneService = {
  cloneRepository(input: CloneRepositoryInput): Promise<CloneRepositoryResult>;
};
