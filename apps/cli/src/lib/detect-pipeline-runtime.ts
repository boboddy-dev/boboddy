import { existsSync } from "node:fs";
import { join } from "node:path";

export interface PipelineRuntime {
  /** Which package-manager / runtime family was detected. */
  kind: "bun" | "tsx" | "deno";
  /** Executable to spawn. */
  command: string;
  /** Args (the script path is appended by the caller). */
  args: string[];
}

interface DetectError {
  ok: false;
  message: string;
}

interface DetectOk {
  ok: true;
  runtime: PipelineRuntime;
}

/**
 * Detect how to run the push script in `pipelineBuilderDir`. Looks only inside
 * that directory — never walks up — so the user's outer repo (which might be a
 * different language entirely) doesn't influence the choice.
 *
 * Priority (first match wins):
 *   1. `bun.lock` or `bun.lockb`           → `bun run <script>`
 *   2. `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` → `./node_modules/.bin/tsx <script>`
 *   3. `deno.lock` / `deno.json`           → `deno run -A <script>`
 *
 * Returns a typed result so callers can produce a clean error message without
 * pulling in CLI-specific logging.
 */
export function detectPipelineRuntime(
  pipelineBuilderDir: string,
): DetectOk | DetectError {
  const has = (file: string) => existsSync(join(pipelineBuilderDir, file));

  if (has("bun.lock") || has("bun.lockb")) {
    return {
      ok: true,
      runtime: { kind: "bun", command: "bun", args: ["run"] },
    };
  }

  if (has("package-lock.json") || has("pnpm-lock.yaml") || has("yarn.lock")) {
    const tsxPath = join(pipelineBuilderDir, "node_modules", ".bin", "tsx");
    if (!existsSync(tsxPath)) {
      return {
        ok: false,
        message:
          "Detected an npm/pnpm/yarn lockfile but tsx is not installed. " +
          "Re-run `npm install` (or `pnpm install` / `yarn install`) inside " +
          ".boboddy/pipeline-builder/ to install it.",
      };
    }
    return {
      ok: true,
      runtime: { kind: "tsx", command: tsxPath, args: [] },
    };
  }

  if (has("deno.lock") || has("deno.json")) {
    return {
      ok: true,
      runtime: { kind: "deno", command: "deno", args: ["run", "-A"] },
    };
  }

  return {
    ok: false,
    message:
      "No supported runtime detected in .boboddy/pipeline-builder/. " +
      "Install dependencies with one of: bun, npm, pnpm, yarn, or deno.",
  };
}
