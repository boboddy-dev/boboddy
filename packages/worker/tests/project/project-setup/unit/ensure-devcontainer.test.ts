import { describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasDevcontainer,
  requireDevcontainer,
} from "../../../../src/project/project-setup/application/ensure-devcontainer";
import { ConfigurationError } from "../../../../src/lib/errors";
import { concurrentTest } from "../../../utils";

describe("hasDevcontainer", () => {
  concurrentTest("returns true for .devcontainer/devcontainer.json", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "boboddy-devcontainer-"));
    try {
      mkdirSync(join(tmpDir, ".devcontainer"));
      writeFileSync(join(tmpDir, ".devcontainer", "devcontainer.json"), "{}", "utf8");
      expect(await hasDevcontainer(tmpDir)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  concurrentTest("returns false when neither config exists", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "boboddy-devcontainer-"));
    try {
      expect(await hasDevcontainer(tmpDir)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("requireDevcontainer", () => {
  concurrentTest("resolves when a devcontainer config exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "boboddy-devcontainer-"));
    try {
      mkdirSync(join(tmpDir, ".devcontainer"));
      writeFileSync(join(tmpDir, ".devcontainer", "devcontainer.json"), "{}", "utf8");
      expect(requireDevcontainer(tmpDir)).resolves.toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  concurrentTest("throws ConfigurationError when no devcontainer exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "boboddy-devcontainer-"));
    try {
      expect(requireDevcontainer(tmpDir)).rejects.toBeInstanceOf(
        ConfigurationError,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
