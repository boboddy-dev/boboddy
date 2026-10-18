import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Env vars read from `.boboddy/.env` in the user's local project directory.
 *
 * Shared between `work` (the real launch path) and anything that has to
 * rehearse the same environment a real step would launch into — a dry run
 * that skipped these could report a health check as unhealthy when the real
 * run, with these vars present, would have passed it.
 */
export async function readLocalEnvVars(
  projectRoot: string = process.cwd(),
): Promise<Record<string, string>> {
  const envFilePath = path.join(projectRoot, ".boboddy", ".env");
  try {
    const content = await readFile(envFilePath, "utf8");
    return dotenv.parse(content);
  } catch {
    // File is optional — absence is not an error.
    return {};
  }
}
