import { describe, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRunOfferGateFailure,
  readAndConsumeRunOfferGateFailure,
  RUN_OFFER_GATE_FAILURE_FILENAME,
  writeRunOfferGateFailure,
} from "../src/lib/design-run-offer-gate-marker";
import { concurrentTest as test } from "./utils";

/**
 * The one channel carrying "the post-push run-offer gate (#146) failed" from
 * one `pipelines design` process into the NEXT one — there is no live agent
 * left to tell when the run offer runs, so this file is the only way the next
 * session's orientation finds out.
 */

function makeBuilderDir(): string {
  return mkdtempSync(join(tmpdir(), "boboddy-run-offer-marker-"));
}

describe("writeRunOfferGateFailure / readAndConsumeRunOfferGateFailure", () => {
  test("round-trips what was written", () => {
    const dir = makeBuilderDir();
    try {
      writeRunOfferGateFailure(dir, {
        pipelineDefinitionId: "019ed1c9-2222-7170-a08a-1ff912085f7b",
        summary: "container exited",
      });

      const failure = readAndConsumeRunOfferGateFailure(dir);
      expect(failure?.pipelineDefinitionId).toBe(
        "019ed1c9-2222-7170-a08a-1ff912085f7b",
      );
      expect(failure?.summary).toBe("container exited");
      expect(typeof failure?.failedAt).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is undefined when nothing was ever written", () => {
    const dir = makeBuilderDir();
    try {
      expect(readAndConsumeRunOfferGateFailure(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is consumed: a second read finds nothing", () => {
    const dir = makeBuilderDir();
    try {
      writeRunOfferGateFailure(dir, {
        pipelineDefinitionId: "pipeline-1",
        summary: "OpenCode unhealthy",
      });

      expect(readAndConsumeRunOfferGateFailure(dir)).toBeDefined();
      expect(readAndConsumeRunOfferGateFailure(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed marker is discarded rather than crashing orientation", () => {
    const dir = makeBuilderDir();
    try {
      writeFileSync(
        join(dir, RUN_OFFER_GATE_FAILURE_FILENAME),
        "not json at all",
        "utf-8",
      );

      expect(readAndConsumeRunOfferGateFailure(dir)).toBeUndefined();
      // Still consumed — a marker broken enough not to parse is no more
      // useful on a second read.
      expect(readAndConsumeRunOfferGateFailure(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clearRunOfferGateFailure", () => {
  test("removes a marker without throwing", () => {
    const dir = makeBuilderDir();
    try {
      writeRunOfferGateFailure(dir, {
        pipelineDefinitionId: "pipeline-1",
        summary: "container exited",
      });

      clearRunOfferGateFailure(dir);

      expect(readAndConsumeRunOfferGateFailure(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does nothing, and does not throw, when there is no marker", () => {
    const dir = makeBuilderDir();
    try {
      expect(() => {
        clearRunOfferGateFailure(dir);
      }).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
