import { describe, expect } from "bun:test";
import {
  buildCreateWorkItemBody,
  buildWorkItemPlatformKey,
  DESIGN_WORK_ITEM_PLATFORM,
  formatWorkItemChoiceLabel,
  parseWorkItemDraft,
  WORK_ITEM_PICKER_LIMIT,
} from "../src/lib/design-work-item";
import { concurrentTest as test } from "./utils";

/**
 * The free-text rung is the only place in the flow where a work item is
 * authored rather than read, so the text-to-item mapping is where the
 * surprises live: an empty description would be rejected by the API, and a
 * colliding platform key would 409 on the user's second session.
 */

describe("parseWorkItemDraft", () => {
  test("uses the first line as the title and the remainder as the description", () => {
    expect(
      parseWorkItemDraft("Checkout 500s on submit\nOnly on Safari.\nStack: …"),
    ).toEqual({
      title: "Checkout 500s on submit",
      description: "Only on Safari.\nStack: …",
    });
  });

  test("falls back to the title as the description for single-line input", () => {
    // `description` is `min(1)` server-side, so an empty remainder would 422.
    expect(parseWorkItemDraft("Fix the flaky login test")).toEqual({
      title: "Fix the flaky login test",
      description: "Fix the flaky login test",
    });
  });

  test("keeps a single-line description whole as both title and description", () => {
    const line = "Fix the flaky checkout test on Safari";

    expect(parseWorkItemDraft(line)).toEqual({
      title: line,
      description: line,
    });
  });

  test("trims surrounding whitespace and blank leading lines", () => {
    expect(parseWorkItemDraft("\n\n  Title here  \n\n  body  \n\n")).toEqual({
      title: "Title here",
      description: "body",
    });
  });

  test("normalises CRLF line endings", () => {
    expect(parseWorkItemDraft("Title\r\nbody line")).toEqual({
      title: "Title",
      description: "body line",
    });
  });

  test("truncates an overlong first line into the title but keeps the full text as the description", () => {
    const long = "x".repeat(300);

    const draft = parseWorkItemDraft(long);

    expect(draft?.title.length).toBeLessThanOrEqual(200);
    expect(draft?.title.endsWith("…")).toBe(true);
    expect(draft?.description).toBe(long);
  });

  test("returns undefined for blank input", () => {
    expect(parseWorkItemDraft("   \n\t\n ")).toBeUndefined();
    expect(parseWorkItemDraft("")).toBeUndefined();
  });
});

describe("buildWorkItemPlatformKey", () => {
  test("never collides across sessions", () => {
    const keys = new Set(
      Array.from({ length: 500 }, () => buildWorkItemPlatformKey()),
    );

    expect(keys.size).toBe(500);
  });

  test("is prefixed so the origin is obvious in the dashboard", () => {
    expect(buildWorkItemPlatformKey()).toStartWith("design-");
  });

  test("is a non-empty trimmed string, as the entity requires", () => {
    const key = buildWorkItemPlatformKey();

    expect(key.trim()).toBe(key);
    expect(key.length).toBeGreaterThan(0);
  });
});

describe("formatWorkItemChoiceLabel", () => {
  test("shows the title and the platform", () => {
    expect(
      formatWorkItemChoiceLabel({
        id: "0197f000-0000-7000-8000-000000000001",
        title: "Checkout 500s on submit",
        description: "…",
        platform: "github",
      }),
    ).toBe("Checkout 500s on submit (github)");
  });

  test("shortens a very long title so the picker stays one line per rung", () => {
    const label = formatWorkItemChoiceLabel({
      id: "0197f000-0000-7000-8000-000000000002",
      title: "y".repeat(200),
      description: "…",
      platform: "jira",
    });

    expect(label.length).toBeLessThanOrEqual(90);
    expect(label).toEndWith("(jira)");
  });
});

describe("buildCreateWorkItemBody", () => {
  const draft = { title: "Flaky login test", description: "One in five." };

  test("marks the item as authored in Boboddy, with no upstream record", () => {
    const body = buildCreateWorkItemBody({ projectId: "p1", draft });

    expect(body).toMatchObject({
      projectId: "p1",
      platform: "boboddy",
      platformId: null,
      url: null,
      title: "Flaky login test",
      description: "One in five.",
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      fields: null,
    });
  });

  test("mints a fresh platform key per call", () => {
    // `(projectId, platform, platformKey)` is the server's uniqueness key, so a
    // reused key would 409 on the user's second design session.
    const first = buildCreateWorkItemBody({ projectId: "p1", draft });
    const second = buildCreateWorkItemBody({ projectId: "p1", draft });

    expect(first.platformKey).not.toBe(second.platformKey);
    expect(first.platformKey.length).toBeGreaterThan(0);
  });

  test("never sends an empty description", () => {
    const single = parseWorkItemDraft("Fix the flaky checkout test");
    if (single === undefined) {
      throw new Error("expected a draft");
    }

    expect(
      buildCreateWorkItemBody({ projectId: "p1", draft: single }).description
        .length,
    ).toBeGreaterThan(0);
  });
});

describe("picker constants", () => {
  test("the picker caps the ingested rungs at 15", () => {
    expect(WORK_ITEM_PICKER_LIMIT).toBe(15);
  });

  test("items authored in the CLI belong to the boboddy platform", () => {
    expect(DESIGN_WORK_ITEM_PLATFORM).toBe("boboddy");
  });
});
