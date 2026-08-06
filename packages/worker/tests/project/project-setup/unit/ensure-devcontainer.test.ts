import { describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEVCONTAINER_CONFIG_PATH,
  hasDevcontainer,
} from "../../../../src/project/project-setup/application/ensure-devcontainer";
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

  concurrentTest("returns true for a root-level devcontainer.json", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "boboddy-devcontainer-"));
    try {
      writeFileSync(join(tmpDir, "devcontainer.json"), "{}", "utf8");
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

  concurrentTest("detects the path it advertises as canonical", async () => {
    // `DEVCONTAINER_CONFIG_PATH` is what the designer is allowed to write. If
    // detection did not recognise it, init would keep reporting a missing
    // devcontainer after the agent had just authored one.
    const tmpDir = mkdtempSync(join(tmpdir(), "boboddy-devcontainer-"));
    try {
      const target = join(tmpDir, DEVCONTAINER_CONFIG_PATH);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "{}", "utf8");
      expect(await hasDevcontainer(tmpDir)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
