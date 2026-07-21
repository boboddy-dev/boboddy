import type { SubmoduleInfo } from "../domain/submodules";

export type DetectSubmodulesInput = {
  workspacePath: string;
};

export type SubmoduleService = {
  detectSubmodules(
    input: DetectSubmodulesInput,
  ): Promise<SubmoduleInfo[]>;
};
