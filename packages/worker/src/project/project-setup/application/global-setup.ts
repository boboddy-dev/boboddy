import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigurationError } from "../../../lib/errors";
import { createLazyLogger } from "../../../lib/logger";

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");
const OPENCODE_CONFIG_FILES = [
  "opencode.jsonc",
  "opencode.json",
  "config.json",
];

const logger = createLazyLogger({
  name: "@boboddy/worker",
  scope: "global-setup",
});

async function hasOpencodeConfig(): Promise<boolean> {
  for (const file of OPENCODE_CONFIG_FILES) {
    try {
      await access(path.join(OPENCODE_CONFIG_DIR, file));
      return true;
    } catch {
      // file not found, try next
    }
  }
  return false;
}

export async function globalSetup(): Promise<void> {
  if (await hasOpencodeConfig()) {
    logger.info("Global setup already complete, skipping.");
  } else {
    throw new ConfigurationError(
      "No opencode configuration found. Install and configure opencode first: https://opencode.ai/docs",
    );
  }
}
