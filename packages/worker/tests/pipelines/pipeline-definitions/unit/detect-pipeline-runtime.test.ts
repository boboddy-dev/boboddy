import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPipelineRuntime } from "../../../../src/pipelines/pipeline-definitions/infra/detect-pipeline-runtime";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "boboddy-detect-runtime-"));
}

describe("detectPipelineRuntime", () => {
  test("returns bun when bun.lock is present", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "bun.lock"), "");
      const result = detectPipelineRuntime(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.runtime.kind).toBe("bun");
        expect(result.runtime.command).toBe("bun");
        expect(result.runtime.args).toEqual(["run"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns bun when bun.lockb is present", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "bun.lockb"), "");
      const result = detectPipelineRuntime(dir);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.runtime.kind).toBe("bun");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns tsx when package-lock.json + tsx in node_modules", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "package-lock.json"), "{}");
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", ".bin", "tsx"), "");
      const result = detectPipelineRuntime(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.runtime.kind).toBe("tsx");
        expect(result.runtime.command).toBe(
          join(dir, "node_modules", ".bin", "tsx"),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors clearly when a node-style lockfile is present but tsx isn't installed", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      const result = detectPipelineRuntime(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("tsx is not installed");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns deno when deno.json is present", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "deno.json"), "{}");
      const result = detectPipelineRuntime(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.runtime.kind).toBe("deno");
        expect(result.runtime.args).toEqual(["run", "-A"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bun.lock takes precedence over a co-resident package-lock.json", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "bun.lock"), "");
      writeFileSync(join(dir, "package-lock.json"), "{}");
      const result = detectPipelineRuntime(dir);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.runtime.kind).toBe("bun");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("errors when no recognized lockfile is present", () => {
    const dir = makeTempDir();
    try {
      const result = detectPipelineRuntime(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("No supported runtime detected");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
