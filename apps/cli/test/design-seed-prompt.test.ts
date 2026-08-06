import { describe, expect } from "bun:test";
import {
  buildDesignSeedPrompt,
  hasAuthoredDefinitions,
  MAX_SEED_DESCRIPTION_LENGTH,
} from "../src/lib/design-seed-prompt";
import { concurrentTest as test } from "./utils";
import type { DesignWorkItem } from "../src/lib/design-work-item";

/**
 * The seed prompt is the session's opening user message, and the only channel
 * carrying the chosen work item into the agent. These tests pin the contract
 * the agent prompt relies on: the item's identity is present, and whether
 * definitions already exist is stated rather than left to be discovered.
 */

const ITEM: DesignWorkItem = {
  id: "0197f000-0000-7000-8000-000000000001",
  title: "Checkout 500s on submit",
  description: "Only on Safari 17. Stack trace in the attachment.",
  platform: "github",
};

describe("buildDesignSeedPrompt", () => {
  test("carries the item's id, title, description, and platform", () => {
    const prompt = buildDesignSeedPrompt({
      workItem: ITEM,
      hasExistingDefinitions: false,
    });

    expect(prompt).toContain(ITEM.id);
    expect(prompt).toContain(ITEM.title);
    expect(prompt).toContain(ITEM.description);
    expect(prompt).toContain(ITEM.platform);
  });

  test("states that no definitions exist yet", () => {
    const prompt = buildDesignSeedPrompt({
      workItem: ITEM,
      hasExistingDefinitions: false,
    });

    expect(prompt).toContain("No pipeline definitions exist yet");
    expect(prompt).not.toContain("Pipeline definitions already exist");
  });

  test("states that definitions already exist", () => {
    const prompt = buildDesignSeedPrompt({
      workItem: ITEM,
      hasExistingDefinitions: true,
    });

    expect(prompt).toContain("Pipeline definitions already exist");
    expect(prompt).not.toContain("No pipeline definitions exist yet");
  });

  test("an edit session is told to get a change-size verdict confirmed", () => {
    // The system prompt gates every file edit in an edit session behind a
    // confirmed tweak/route/new-pipeline verdict, and this flag is what decides
    // whether that gate applies at all. The two have to say the same thing.
    const prompt = buildDesignSeedPrompt({
      workItem: ITEM,
      hasExistingDefinitions: true,
    });

    expect(prompt).toContain("verdict");
    expect(prompt).toContain("before editing any file");
    // The three verdict names are the shared vocabulary — if either side
    // renames one, the seed asks for something the system prompt cannot answer.
    for (const verdict of ["tweak", "route", "new pipeline"]) {
      expect(prompt, verdict).toContain(verdict);
    }
  });

  test("asks the agent to start the interview", () => {
    // Without an instruction the TUI opens on a bare data dump.
    expect(
      buildDesignSeedPrompt({
        workItem: ITEM,
        hasExistingDefinitions: false,
      }),
    ).toContain("Start the interview");
  });

  test("caps a runaway description — the prompt travels as an argv entry", () => {
    const prompt = buildDesignSeedPrompt({
      workItem: { ...ITEM, description: "z".repeat(50_000) },
      hasExistingDefinitions: false,
    });

    expect(prompt.length).toBeLessThan(MAX_SEED_DESCRIPTION_LENGTH + 2_000);
    expect(prompt).toContain("truncated");
  });

  test("leaves a description at the cap untruncated", () => {
    const description = "z".repeat(MAX_SEED_DESCRIPTION_LENGTH);

    const prompt = buildDesignSeedPrompt({
      workItem: { ...ITEM, description },
      hasExistingDefinitions: false,
    });

    expect(prompt).toContain(description);
    expect(prompt).not.toContain("truncated");
  });

  test("is deterministic", () => {
    const input = { workItem: ITEM, hasExistingDefinitions: true };

    expect(buildDesignSeedPrompt(input)).toBe(buildDesignSeedPrompt(input));
  });
});

describe("hasAuthoredDefinitions", () => {
  test("an empty directory has none", () => {
    expect(hasAuthoredDefinitions([])).toBe(false);
  });

  test("a freshly scaffolded directory has none", () => {
    // The regression this pins: the preflight scaffolds `triage-and-plan.ts`
    // and `default-pipeline-assignment.ts` immediately before the flag is read,
    // so counting every `.ts` file reported "definitions already exist" on a
    // first run and told the agent to review boilerplate as if it were the
    // user's own design.
    expect(
      hasAuthoredDefinitions([
        "package.json",
        "tsconfig.json",
        ".gitignore",
        "triage-and-plan.ts",
        "default-pipeline-assignment.ts",
      ]),
    ).toBe(false);
  });

  test("an authored pipeline counts", () => {
    expect(
      hasAuthoredDefinitions([
        "triage-and-plan.ts",
        "default-pipeline-assignment.ts",
        "checkout-repro.ts",
      ]),
    ).toBe(true);
  });

  test("the generated push script does not count", () => {
    expect(hasAuthoredDefinitions(["push.ts"])).toBe(false);
  });

  test("non-TypeScript files do not count", () => {
    expect(hasAuthoredDefinitions(["README.md", "package.json"])).toBe(false);
  });
});
