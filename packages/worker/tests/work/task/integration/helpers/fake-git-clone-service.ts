import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FakeGitRemote } from "./fake-git-remote";
import type {
  CloneRepositoryInput,
  CloneRepositoryResult,
  GitCloneService,
} from "../../../../../src/runtime/runtime-service/application/git-clone-service";

export type { CloneRepositoryInput, CloneRepositoryResult };

const execFileAsync = promisify(execFile);

const DUMMY_REPO_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dummy-repo",
);

const DEFAULT_BRANCH = "main";

const CODE_STEP_LOOKUP_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../sdks/js/src/push/code-step-lookup.ts",
);

/**
 * Stands in for the `@boboddy/sdk` a real repo has installed under
 * `.boboddy/pipeline-builder/node_modules`: just the `code-step-lookup`
 * subpath the code-step runner imports, transpiled from the real source so the
 * container (which sees only the workspace) runs the real lookup.
 */
async function installCodeStepLookup(workspacePath: string): Promise<void> {
  const sdkDir = path.join(
    workspacePath,
    ".boboddy",
    "pipeline-builder",
    "node_modules",
    "@boboddy",
    "sdk",
  );
  const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
    await readFile(CODE_STEP_LOOKUP_SOURCE, "utf8"),
  );
  await mkdir(sdkDir, { recursive: true });
  await writeFile(
    path.join(sdkDir, "package.json"),
    JSON.stringify({
      name: "@boboddy/sdk",
      type: "module",
      exports: { "./code-step-lookup": "./code-step-lookup.js" },
    }),
  );
  await writeFile(path.join(sdkDir, "code-step-lookup.js"), transpiled);
}

/**
 * Test double for the production GitCliCloneService. Instead of cloning over
 * the network, it copies the bundled dummy repo fixture into the workspace and
 * initializes a real local git repo (so resolveBranchName and any downstream
 * git expectations are satisfied). No network access required. When given a
 * {@link FakeGitRemote}, the clone's `origin` points at that local bare repo so
 * the work-branch push is real.
 */
export class FakeGitCloneService implements GitCloneService {
  constructor(
    private readonly sourceRepoDir: string = DUMMY_REPO_DIR,
    private readonly remote?: FakeGitRemote,
  ) {}

  async cloneRepository(
    input: CloneRepositoryInput,
  ): Promise<CloneRepositoryResult> {
    // The workspace directory already exists (created by the workspace
    // manager); copy the fixture contents into it.
    await cp(this.sourceRepoDir, input.workspacePath, {
      recursive: true,
      force: true,
    });
    await installCodeStepLookup(input.workspacePath);

    await this.git(input.workspacePath, ["init", "-b", DEFAULT_BRANCH]);
    await this.git(input.workspacePath, [
      "config",
      "user.email",
      "integration@boboddy.dev",
    ]);
    await this.git(input.workspacePath, [
      "config",
      "user.name",
      "Boboddy Integration",
    ]);
    await this.git(input.workspacePath, ["add", "-A"]);
    await this.git(input.workspacePath, [
      "commit",
      "--no-gpg-sign",
      "-m",
      "Initial dummy commit",
    ]);

    await this.remote?.attach(input.workspacePath);

    return { resolvedBranch: DEFAULT_BRANCH };
  }

  private async git(workspacePath: string, args: string[]): Promise<void> {
    await execFileAsync("git", ["-C", workspacePath, ...args], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  }
}
